// index.mjs — estimator (시간별 비용 추정기)
// Runtime: Node.js 20.x (AWS SDK v3 는 런타임 내장)
//
// 매시 :10 KST 에 EventBridge Scheduler 가 실행.
// 직전 "완료된 1시간" 구간의 CloudWatch 지표(+ traffic_logs 캐시미스율)를 읽어
//   추정비용(h) = Σ 고정비단가  +  Σ (사용량신호 × 단가 × 보정계수[service])
// 로 계산하고 DynamoDB 에 서비스별 추정치(EST#)를 저장한다.
//
// 설계 원칙(저장 최소화):
//   - 원본 신호(CloudWatch 지표)는 AWS 가 이미 보관하므로 우리가 저장하지 않는다.
//   - 우리 쪽엔 "집계 결과(추정치/사용량 스냅샷)"만 남기고, EST# 항목엔 TTL 을 걸어 자동 폐기.
//   - 보정계수(COEF#)/정확도(ACC#)만 장기 보존.

import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand } from "@aws-sdk/client-elastic-load-balancing-v2";
import { CloudFrontClient, ListDistributionsCommand } from "@aws-sdk/client-cloudfront";
import { EC2Client, DescribeNatGatewaysCommand, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { Route53Client, ListHostedZonesCommand } from "@aws-sdk/client-route-53";
import { DynamoDBClient, PutItemCommand, GetItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const REGION = process.env.REGION || "ap-northeast-2";

// CloudWatch 는 리전별 → 서울(대부분) + 글로벌(CloudFront 는 us-east-1) 두 클라이언트
const cwSeoul = new CloudWatchClient({ region: REGION });
const cwGlobal = new CloudWatchClient({ region: "us-east-1" });
const elb = new ElasticLoadBalancingV2Client({ region: REGION });
const cf = new CloudFrontClient({ region: "us-east-1" }); // CloudFront 는 글로벌 엔드포인트
const ec2 = new EC2Client({ region: REGION });
const r53 = new Route53Client({ region: "us-east-1" }); // Route53 은 글로벌 엔드포인트
const ddb = new DynamoDBClient({ region: REGION });

const DDB_TABLE = process.env.DDB_TABLE;
const ALB_NAME = process.env.ALB_NAME || "app-alb";
const RDS_ID = process.env.RDS_ID || "cj-olive0";
const CF_ALIAS = process.env.CF_ALIAS || "sharpynloxoln.store";
const R53_DOMAIN = process.env.R53_DOMAIN || "sharpynloxoln.store."; // 퍼블릭 호스팅 존 이름(끝점 포함)
const EC2_TAG_NAME = process.env.EC2_TAG_NAME || "ec2-app";
const IMAGES_BUCKET = process.env.IMAGES_BUCKET || "olive-product";
const STATIC_BUCKET = process.env.STATIC_BUCKET || "front-caching";
const EST_TTL_DAYS = Number(process.env.EST_TTL_DAYS || 90);

// ---- 이상 탐지(시그마 기반 심각도) 설정 ----
const SLACK_API_ENDPOINT = process.env.SLACK_API_ENDPOINT; // 미설정 시 슬랙 전송 생략(ALERT 기록만)
const COMPANY_NAME = process.env.COMPANY_NAME || "올리브영";
const Z_WARN = Number(process.env.Z_WARN || 2); // 2σ 초과 ≈ 상위 2.3% → WARNING
const Z_CRIT = Number(process.env.Z_CRIT || 4); // 4σ 초과 ≈ 상위 0.003% → CRITICAL
const MIN_SAMPLES = Number(process.env.MIN_SAMPLES || 3); // baseline 최소 표본
const BASELINE_DAYS = Number(process.env.BASELINE_DAYS || 28); // 같은 시간대 며칠치로 baseline
const ALERT_TTL_DAYS = Number(process.env.ALERT_TTL_DAYS || 30);

// ---------------------------------------------------------------------
// 단가표 (ap-northeast-2 근사치, USD). 정확할 필요 없음 — 보정계수가 오차를 흡수.
// 더 정확히 하려면 Price List API 실값으로 교체.
// ---------------------------------------------------------------------
const PRICES = {
  ec2_t3small_hr: 0.026, // t3.small 온디맨드 시간당
  ec2_surplus_vcpu_hr: 0.05, // T3 unlimited 초과 크레딧 (vCPU-hour 근사)
  rds_t3small_hr: 0.036, // db.t3.small 단일 AZ (Multi-AZ 는 ×2)
  rds_storage_gb_month: 0.131, // gp2 GB-월
  nat_hr: 0.059, // NAT Gateway 시간당(게이트웨이당)
  nat_gb: 0.059, // NAT 처리 GB당
  alb_hr: 0.0225, // ALB 시간당 고정
  alb_lcu_hr: 0.008, // LCU-시간당
  cf_req_10k: 0.012, // CloudFront HTTPS 요청 1만건당
  cf_gb: 0.114, // CloudFront 아웃바운드 GB당
  s3_get_1k: 0.0004, // S3 GET 1천건당
  r53_zone_month: 0.5, // Route53 호스팅 존 월정액
  r53_query_1m: 0.4, // Route53 표준 쿼리 100만건당 (첫 10억건 구간)
};

const HOURS_PER_MONTH = 730;
const round4 = (n) => Math.round(n * 1e4) / 1e4;

// 서비스 id 목록 — Cost Explorer 서비스명과 조인되도록 보정기와 동일 체계 사용
//   ec2(=Compute) / ec2-other(=NAT·EBS·EIP) / rds / cloudfront / s3 / route53 / elb
const SERVICES = ["ec2", "ec2-other", "rds", "cloudfront", "s3", "route53", "elb"];

// 트래픽과 무관하게 항상 켜져있는 고정비 (시간당)
function fixedCosts() {
  return {
    ec2: 2 * PRICES.ec2_t3small_hr, // EC2 2대
    "ec2-other": 2 * PRICES.nat_hr, // NAT 2개 시간요금
    rds: 2 * PRICES.rds_t3small_hr + (20 * PRICES.rds_storage_gb_month) / HOURS_PER_MONTH, // Multi-AZ = ×2 + 20GB
    elb: PRICES.alb_hr,
    route53: PRICES.r53_zone_month / HOURS_PER_MONTH,
    cloudfront: 0,
    s3: 0,
  };
}

// ---------------------------------------------------------------------
// 리소스 ID 런타임 디스커버리 (finops state 가 메인 인프라와 분리돼 있으므로)
// 실패해도 해당 신호만 0 이 되고 나머지는 정상 동작하도록 best-effort.
// ---------------------------------------------------------------------
async function discover() {
  const out = { albSuffix: null, cfId: null, natIds: [], ec2Ids: [], r53ZoneId: null };

  try {
    const r = await elb.send(new DescribeLoadBalancersCommand({ Names: [ALB_NAME] }));
    const arn = r.LoadBalancers?.[0]?.LoadBalancerArn;
    if (arn) out.albSuffix = arn.split(":loadbalancer/")[1]; // app/app-alb/xxxxxxxx
  } catch (e) {
    console.warn("ALB 디스커버리 실패:", e.message);
  }

  try {
    const r = await cf.send(new ListDistributionsCommand({}));
    const item = (r.DistributionList?.Items || []).find((d) =>
      (d.Aliases?.Items || []).includes(CF_ALIAS)
    );
    if (item) out.cfId = item.Id;
  } catch (e) {
    console.warn("CloudFront 디스커버리 실패:", e.message);
  }

  try {
    const r = await ec2.send(
      new DescribeNatGatewaysCommand({ Filter: [{ Name: "state", Values: ["available"] }] })
    );
    out.natIds = (r.NatGateways || []).map((n) => n.NatGatewayId);
  } catch (e) {
    console.warn("NAT 디스커버리 실패:", e.message);
  }

  try {
    const r = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: "tag:Name", Values: [EC2_TAG_NAME] },
          { Name: "instance-state-name", Values: ["running"] },
        ],
      })
    );
    out.ec2Ids = (r.Reservations || []).flatMap((res) =>
      (res.Instances || []).map((i) => i.InstanceId)
    );
  } catch (e) {
    console.warn("EC2 디스커버리 실패:", e.message);
  }

  try {
    const r = await r53.send(new ListHostedZonesCommand({}));
    const zone = (r.HostedZones || []).find(
      (z) => !z.Config?.PrivateZone && z.Name === R53_DOMAIN
    );
    // HostedZone.Id 는 "/hostedzone/ZXXXX" 형태 → CloudWatch dimension 은 접두사 없는 ZXXXX
    if (zone?.Id) out.r53ZoneId = zone.Id.replace("/hostedzone/", "");
  } catch (e) {
    console.warn("Route53 디스커버리 실패:", e.message);
  }

  return out;
}

// ---------------------------------------------------------------------
// GetMetricData 쿼리 조립 헬퍼 — id → {logical} 매핑을 함께 기록해 합산
// ---------------------------------------------------------------------
async function collectUsage(d, start, end) {
  const meta = {};
  let idx = 0;
  const seoulQ = [];
  const globalQ = [];

  const addQ = (list, ns, name, dims, stat, logical) => {
    const id = `m${idx++}`;
    meta[id] = { logical };
    list.push({
      Id: id,
      MetricStat: { Metric: { Namespace: ns, MetricName: name, Dimensions: dims }, Period: 3600, Stat: stat },
      ReturnData: true,
    });
  };

  // ALB — LCU (변동, elb)
  if (d.albSuffix) {
    addQ(seoulQ, "AWS/ApplicationELB", "ConsumedLCUs", [{ Name: "LoadBalancer", Value: d.albSuffix }], "Average", "albLcu");
  }
  // NAT — 처리 바이트 (변동, ec2-other). 게이트웨이별 쿼리를 같은 logical 로 합산
  for (const id of d.natIds) {
    addQ(seoulQ, "AWS/NATGateway", "BytesOutToDestination", [{ Name: "NatGatewayId", Value: id }], "Sum", "natBytes");
  }
  // EC2 — 초과 CPU 크레딧 (변동, ec2). EC2_LOAD_SPAM 시나리오가 건드리는 축
  for (const id of d.ec2Ids) {
    addQ(seoulQ, "AWS/EC2", "CPUSurplusCreditsCharged", [{ Name: "InstanceId", Value: id }], "Sum", "ec2Surplus");
  }
  // RDS — I/O·CPU (gp2 는 I/O 별도 과금 없음 → 비용 기여는 작지만, 이상탐지용 스냅샷으로 저장)
  addQ(seoulQ, "AWS/RDS", "WriteIOPS", [{ Name: "DBInstanceIdentifier", Value: RDS_ID }], "Average", "rdsWriteIops");
  addQ(seoulQ, "AWS/RDS", "ReadIOPS", [{ Name: "DBInstanceIdentifier", Value: RDS_ID }], "Average", "rdsReadIops");
  addQ(seoulQ, "AWS/RDS", "CPUUtilization", [{ Name: "DBInstanceIdentifier", Value: RDS_ID }], "Average", "rdsCpu");
  // (S3 request metrics 는 비용 절감 위해 제거됨 → s3 변동비는 0 으로 취급.
  //  필요 시 log-buckets 에 aws_s3_bucket_metric "EntireBucket" 을 되살리고 아래 쿼리를 복구)
  // CloudFront — 요청/전송량 (변동, cloudfront). 반드시 us-east-1 + Region=Global
  if (d.cfId) {
    addQ(globalQ, "AWS/CloudFront", "Requests", [{ Name: "DistributionId", Value: d.cfId }, { Name: "Region", Value: "Global" }], "Sum", "cfReq");
    addQ(globalQ, "AWS/CloudFront", "BytesDownloaded", [{ Name: "DistributionId", Value: d.cfId }, { Name: "Region", Value: "Global" }], "Sum", "cfBytes");
  }
  // Route53 — DNS 쿼리 수 (변동, route53). 지표는 us-east-1 전용 → globalQ
  if (d.r53ZoneId) {
    addQ(globalQ, "AWS/Route53", "DNSQueries", [{ Name: "HostedZoneId", Value: d.r53ZoneId }], "Sum", "r53Queries");
  }

  const usage = {};
  const run = async (client, queries) => {
    if (!queries.length) return;
    const res = await client.send(
      new GetMetricDataCommand({ StartTime: start, EndTime: end, MetricDataQueries: queries, ScanBy: "TimestampDescending" })
    );
    for (const r of res.MetricDataResults || []) {
      const v = r.Values && r.Values.length ? r.Values[0] : 0;
      const logical = meta[r.Id].logical;
      usage[logical] = (usage[logical] || 0) + v;
    }
  };
  await run(cwSeoul, seoulQ);
  await run(cwGlobal, globalQ);
  return usage;
}

async function getCoeff(service) {
  try {
    const r = await ddb.send(new GetItemCommand({ TableName: DDB_TABLE, Key: marshall({ pk: "COEF", sk: service }) }));
    if (r.Item) {
      const c = Number(unmarshall(r.Item).coeff);
      if (Number.isFinite(c) && c > 0) return c;
    }
  } catch (e) {
    console.warn(`보정계수 조회 실패(${service}):`, e.message);
  }
  return 1;
}

// ---------------------------------------------------------------------
// 이상 탐지 (계절성 인지형 baseline + 시그마 심각도)
// ---------------------------------------------------------------------

// YYYY-MM-DD 에서 n일 전 날짜 문자열
function prevDay(dateStr, n) {
  const t = new Date(`${dateStr}T00:00:00Z`).getTime() - n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

// 표본 통계 (표본표준편차, ddof=1)
function stats(samples) {
  const n = samples.length;
  if (n === 0) return { n, mean: 0, std: 0 };
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { n, mean, std: 0 };
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return { n, mean, std: Math.sqrt(variance) };
}

// 같은 "시간대(hour-of-day)" 기준으로 과거 며칠치 서비스별 추정치를 수집
// → 계절성(점심/퇴근 피크, 화~토 패턴)을 그대로 반영. 없으면 최근 시간들로 폴백.
async function buildBaseline(dayUTC, HH) {
  const seasonal = {}; // service -> number[]
  for (let d = 1; d <= BASELINE_DAYS; d++) {
    const dp = prevDay(dayUTC, d);
    try {
      const r = await ddb.send(
        new QueryCommand({
          TableName: DDB_TABLE,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :h)",
          ExpressionAttributeValues: marshall({ ":pk": `EST#${dp}`, ":h": `${dp}T${HH}` }),
        })
      );
      for (const raw of r.Items || []) {
        const it = unmarshall(raw);
        if (it.type !== "estimate") continue;
        (seasonal[it.service] ||= []).push(it.estimated);
      }
    } catch (e) {
      /* 해당 날짜 데이터 없음 — 무시 */
    }
  }
  return seasonal;
}

// 최근 시간들(오늘+어제, 현재시각 제외)로 폴백 baseline — cold start / 계절성 표본 부족 시
async function trailingBaseline(dayUTC, currentHourKey) {
  const byService = {};
  for (const dp of [dayUTC, prevDay(dayUTC, 1)]) {
    try {
      const r = await ddb.send(
        new QueryCommand({
          TableName: DDB_TABLE,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: marshall({ ":pk": `EST#${dp}` }),
        })
      );
      for (const raw of r.Items || []) {
        const it = unmarshall(raw);
        if (it.type !== "estimate" || it.hourUTC === currentHourKey) continue;
        (byService[it.service] ||= []).push(it.estimated);
      }
    } catch (e) {
      /* 무시 */
    }
  }
  return byService;
}

// 서비스별 추정 원인 힌트 (시나리오 지식 기반)
function causeHint(service) {
  switch (service) {
    case "cloudfront":
      return "CloudFront 요청/전송량 급증 — 캐시 미스율 상승(롱테일/스크래핑) 의심";
    case "elb":
      return "ALB LCU 급증 — 트래픽/신규 커넥션 폭증 의심";
    case "ec2":
      return "EC2 초과 CPU 크레딧 과금 — 인스턴스 부하 급증(EC2_LOAD 유형) 의심";
    case "ec2-other":
      return "NAT 아웃바운드 전송량 급증 — 외부 다운로드/유출 의심";
    case "s3":
      return "S3 GET 요청 급증 의심";
    case "rds":
      return "RDS I/O·CPU 급증 — 쓰기 폭주(RDS_WRITE 유형) 의심";
    default:
      return "평소 대비 비용 급증";
  }
}

const round2 = (n) => Math.round(n * 100) / 100;

// z-score → 심각도
function severityOf(z) {
  if (!Number.isFinite(z)) return null;
  if (z >= Z_CRIT) return "CRITICAL";
  if (z >= Z_WARN) return "WARNING";
  return null;
}

// slack-notifier(API Gateway) 로 심각도 포함 전송. 실패해도 추정 결과엔 영향 없음.
async function notifySlack(payload) {
  if (!SLACK_API_ENDPOINT) return;
  try {
    const res = await fetch(SLACK_API_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.warn("슬랙 전송 실패:", res.status);
  } catch (e) {
    console.warn("슬랙 전송 예외:", e.message);
  }
}

// 현재 시각 서비스별 추정치를 baseline 과 비교해 이상 탐지 → ALERT 기록 + 슬랙
async function detectAndAlert(perService, dayUTC, hourKey, usage, endEpochSec) {
  const HH = hourKey.slice(11, 13);
  const seasonal = await buildBaseline(dayUTC, HH);
  let trailing = null; // 필요 시 지연 로딩

  const ttl = endEpochSec + ALERT_TTL_DAYS * 86400;
  const alerts = [];

  for (const [service, current] of Object.entries(perService)) {
    // 1) 계절성 baseline 우선
    let samples = seasonal[service] || [];
    let mode = "seasonal";
    // 2) 표본 부족하면 최근시간 폴백 (cold start 데모 대응)
    if (samples.length < MIN_SAMPLES) {
      if (!trailing) trailing = await trailingBaseline(dayUTC, hourKey);
      samples = trailing[service] || [];
      mode = "trailing";
    }
    if (samples.length < MIN_SAMPLES) continue; // 아직 판단 불가

    const { n, mean, std } = stats(samples);
    if (std <= 0) continue; // 분산 0 (고정비만) → 스킵
    const z = (current - mean) / std;
    const severity = severityOf(z);
    if (!severity) continue;

    const alert = {
      service,
      severity,
      z: round2(z),
      expected: round2(mean),
      actual: round2(current),
      baselineMode: mode,
      baselineN: n,
      cause: causeHint(service),
    };
    alerts.push(alert);

    // ALERT 기록 (status=OPEN, 담당자 확인 전까지 유지 — ack 는 별도 API 에서)
    await ddb.send(
      new PutItemCommand({
        TableName: DDB_TABLE,
        Item: marshall(
          {
            pk: "ALERT",
            sk: `${hourKey}#${service}`,
            type: "alert",
            status: "OPEN",
            company: COMPANY_NAME,
            service,
            severity,
            z: round2(z),
            expected: round2(mean),
            actual: round2(current),
            detectedAt: new Date().toISOString(),
            hourUTC: hourKey,
            summary: `${service} 추정비용 $${round2(current)} (평소 $${round2(mean)}, ${round2(z)}σ)`,
            cause: causeHint(service),
            ttl,
          },
          { removeUndefinedValues: true }
        ),
      })
    );

    // 슬랙 전송 (심각도 포함)
    await notifySlack({
      company: COMPANY_NAME,
      severity,
      service,
      rawData: `${service} 시간당 추정 $${round2(current)} (baseline 평균 $${round2(mean)}, ${mode}, n=${n})`,
      summary: `${service} 추정비용이 평소 대비 ${round2(z)}σ 상승`,
      cause: causeHint(service),
      actionRequired: severity === "CRITICAL",
      metric: { expected: round2(mean), actual: round2(current), z: round2(z), sigma: round2(z) },
      detectedAt: new Date().toISOString(),
      hourUTC: hourKey,
    });
  }

  if (alerts.length) console.log(`[estimator] 이상 탐지 ${alerts.length}건`, alerts);
  return alerts;
}

export const handler = async (event = {}) => {
  if (!DDB_TABLE) throw new Error("DDB_TABLE 미설정");

  // 대상 1시간 구간 [start, end)
  // - 평상시: 직전 "완료된 1시간" (UTC 정시 내림. KST 는 +9 정시 오프셋이라 UTC정시=KST정시)
  // - 데모용: event.targetHourISO ("YYYY-MM-DDTHH", UTC 기준) 를 주면 그 시간을 즉시 추정
  //   → 비정상 주입 직후 :10 까지 안 기다리고 수동 invoke 로 바로 탐지 시연 가능
  const now = new Date();
  let end;
  if (event.targetHourISO) {
    const base = new Date(`${event.targetHourISO}:00:00Z`);
    if (Number.isNaN(base.getTime())) throw new Error(`잘못된 targetHourISO: ${event.targetHourISO}`);
    end = new Date(base.getTime() + 3600000);
  } else {
    end = new Date(Math.floor(now.getTime() / 3600000) * 3600000);
  }
  const start = new Date(end.getTime() - 3600000);

  const d = await discover();
  const usage = await collectUsage(d, start, end);

  const fixed = fixedCosts();
  const coeff = {};
  for (const s of SERVICES) coeff[s] = await getCoeff(s);

  // 변동비 (사용량 × 단가). 보정계수는 아래에서 곱함.
  const variableRaw = {
    elb: (usage.albLcu || 0) * PRICES.alb_lcu_hr,
    "ec2-other": ((usage.natBytes || 0) / 1e9) * PRICES.nat_gb,
    ec2: (usage.ec2Surplus || 0) * PRICES.ec2_surplus_vcpu_hr,
    cloudfront: ((usage.cfReq || 0) / 10000) * PRICES.cf_req_10k + ((usage.cfBytes || 0) / 1e9) * PRICES.cf_gb,
    s3: ((usage.s3Get || 0) / 1000) * PRICES.s3_get_1k,
    rds: 0, // gp2 는 I/O 별도 과금 없음 → 변동비 0 (사용량은 스냅샷에만 기록)
    route53: ((usage.r53Queries || 0) / 1e6) * PRICES.r53_query_1m, // DNS 쿼리 100만건당 과금
  };

  const dayUTC = start.toISOString().slice(0, 10); // YYYY-MM-DD
  const hourKey = start.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  const ttl = Math.floor(end.getTime() / 1000) + EST_TTL_DAYS * 86400;

  let total = 0;
  const perService = {};
  for (const s of SERVICES) {
    // 통합 coeff 모델: 보정계수를 (고정비+변동비) 전체에 곱해 서비스 전체를 스케일한다.
    // → 고정비만 있는 서비스(rds/route53 등)도 coeff 로 오차를 흡수·수렴할 수 있다.
    const baseRaw = (fixed[s] || 0) + (variableRaw[s] || 0); // pre-coeff 합
    const est = round4(baseRaw * (coeff[s] || 1));
    perService[s] = est;
    total += est;

    await ddb.send(
      new PutItemCommand({
        TableName: DDB_TABLE,
        Item: marshall(
          {
            pk: `EST#${dayUTC}`,
            sk: `${hourKey}#${s}`,
            type: "estimate",
            service: s,
            hourUTC: hourKey,
            fixed: round4(fixed[s] || 0),
            variable: round4(variableRaw[s] || 0), // pre-coeff 변동비(raw) — reconciler 가 base 복원에 사용
            coeff: round4(coeff[s] || 1),
            estimated: est, // = (fixed + variable) * coeff
            ttl,
          },
          { removeUndefinedValues: true }
        ),
      })
    );
  }

  // 사용량 스냅샷 1건 (이상탐지 단계에서 재활용). raw 로그가 아니라 시간당 집계값만.
  await ddb.send(
    new PutItemCommand({
      TableName: DDB_TABLE,
      Item: marshall(
        {
          pk: `EST#${dayUTC}`,
          sk: `${hourKey}#__usage`,
          type: "usage",
          hourUTC: hourKey,
          albLcu: round4(usage.albLcu || 0),
          natBytes: Math.round(usage.natBytes || 0),
          ec2Surplus: round4(usage.ec2Surplus || 0),
          cfReq: Math.round(usage.cfReq || 0),
          cfBytes: Math.round(usage.cfBytes || 0),
          s3Get: Math.round(usage.s3Get || 0),
          rdsWriteIops: round4(usage.rdsWriteIops || 0),
          rdsReadIops: round4(usage.rdsReadIops || 0),
          rdsCpu: round4(usage.rdsCpu || 0),
          r53Queries: Math.round(usage.r53Queries || 0),
          estimatedTotal: round4(total),
          discovered: { albSuffix: d.albSuffix, cfId: d.cfId, natCount: d.natIds.length, ec2Count: d.ec2Ids.length, r53ZoneId: d.r53ZoneId },
          ttl,
        },
        { removeUndefinedValues: true }
      ),
    })
  );

  // 이상 탐지 → ALERT 기록 + 슬랙(심각도 포함). 탐지 실패해도 추정 결과는 보존.
  let alerts = [];
  try {
    alerts = await detectAndAlert(perService, dayUTC, hourKey, usage, Math.floor(end.getTime() / 1000));
  } catch (e) {
    console.warn("탐지 단계 예외:", e.message);
  }

  console.log(`[estimator] ${hourKey} 추정 완료: $${round4(total)}`, perService);
  return {
    statusCode: 200,
    body: JSON.stringify({ hourUTC: hourKey, estimatedTotal: round4(total), perService, alerts }),
  };
};
