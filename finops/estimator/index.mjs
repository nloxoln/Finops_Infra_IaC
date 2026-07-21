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
  ec2_surplus_vcpu_hr: 0.05, // t3 unlimited 초과 크레딧 (vCPU-hour 근사)
  rds_t3small_hr: 0.036, // db.t3.small (Multi-AZ, 1개 대기)
  rds_storage_gb_month: 0.131, // gp2 GB당 월 고정
  nat_hr: 0.059, // NAT Gateway 시간당
  nat_gb: 0.059, // NAT 처리 GB당
  alb_hr: 0.0225, // ALB 시간당 고정
  alb_lcu_hr: 0.008, // LCU 시간당
  cf_req_10k: 0.012, // CloudFront HTTPS 요청 1만건당
  cf_gb: 0.114, // CloudFront 아웃바운드 GB당
  s3_get_1k: 0.0004, // S3 GET 1천건당
  r53_zone_month: 0.5, // Route53 호스팅존 월정액
  r53_query_1m: 0.4, // Route53 표준 쿼리 100만건당
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

// 같은 "시간대(hour-of-day)" 기준으로 과거 며칠치 서비스별 값을 수집
// → 계절성(점심/퇴근 피크) 반영. 없으면 최근 시간들로 폴백(trailingBaseline).
//
// [하이브리드 baseline] 각 과거 날짜마다:
//   1순위) ACTUAL#{날짜} — CUR 기반 시간별 실제비용 (reconciler 가 저장, ≈T-2 이상)
//   2순위) EST#{날짜}    — 실제값이 아직 없는 최근 날짜(어제/오늘)는 추정치로 폴백
// → "나온 건 실제값, 아직 안 나온 건 추정치"로 baseline 정확도를 높인다.
async function buildBaseline(dayUTC, HH) {
  const seasonal = {}; // service -> number[]
  for (let d = 1; d <= BASELINE_DAYS; d++) {
    const dp = prevDay(dayUTC, d);

    // 1순위: 실제값(ACTUAL#) 조회
    let usedActual = false;
    try {
      const ra = await ddb.send(
        new QueryCommand({
          TableName: DDB_TABLE,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :h)",
          ExpressionAttributeValues: marshall({ ":pk": `ACTUAL#${dp}`, ":h": `${dp}T${HH}` }),
        })
      );
      for (const raw of ra.Items || []) {
        const it = unmarshall(raw);
        if (it.type !== "actual") continue;
        (seasonal[it.service] ||= []).push(it.actual);
        usedActual = true;
      }
    } catch (e) {
      /* 실제값 없음 — 추정치로 폴백 */
    }
    if (usedActual) continue; // 그 날짜는 실제값으로 채웠으니 추정치 건너뜀

    // 2순위: 추정치(EST#) 폴백
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

// =====================================================================
// 이상 원인 규칙 카탈로그 (rule catalog)
// ---------------------------------------------------------------------
// 설계 의도:
//   - 데이터가 적은 PoC 단계라 원인 판정은 "규칙 기반"이 안전하다(LLM 미사용).
//   - 규칙은 풍부하게(카탈로그로) 정의해두고, 실제로는 조건(match)을 충족한
//     규칙만 발화한다. 현재 주입 시나리오(CACHE_MISS/EC2_LOAD/SALE/RDS_WRITE)는
//     아래 규칙 중 일부에만 매칭되며, 나머지 규칙(DATA_EXFIL 등)은 카탈로그에
//     존재하되 해당 신호가 없으면 조용하다.
//   - 각 규칙은 심각도 가중(sevBoost)·원인·해결방안·콘솔 확인 경로를 담아
//     알람과 종합보고서 텍스트를 함께 생성한다.
//
// ctx: { service, z, severity, current, expected, usage, perService }
//   - usage: 이번 시간 사용량 스냅샷(albLcu/natBytes/cfReq/rdsWriteIops 등)
//   - perService: 이번 시간 서비스별 추정치(교차 서비스 조건에 사용)
// =====================================================================
const RULE_CATALOG = [
  {
    id: "CACHE_MISS_SPAM",
    title: "CloudFront 캐시 미스 급증",
    resourceType: "CloudFront",
    match: (c) => c.service === "cloudfront",
    cause:
      "CloudFront 요청·전송량 급증. 인기상품 외 롱테일 이미지 요청이 몰려 캐시 미스율이 올라가면 오리진(ALB/S3) 조회와 데이터 전송 비용이 함께 증가한다. 스크래핑/봇 트래픽 가능성.",
    action:
      "① 캐시 정책(TTL) 상향 및 이미지 경로 캐싱 확인 ② WAF Rate-based rule로 비정상 요청 차단 ③ 인기상품 캐시 워밍 ④ Referer/UA 기반 스크래핑 필터",
    console:
      "CloudFront 콘솔 → 대상 배포 → Reports & analytics → Cache statistics(미스율) / Popular objects. CloudWatch(us-east-1) → CloudFront → Requests·BytesDownloaded",
  },
  {
    id: "EC2_LOAD_SPAM",
    title: "EC2 부하 급증(초과 크레딧 과금)",
    resourceType: "EC2",
    match: (c) => c.service === "ec2",
    cause:
      "T3 인스턴스의 CPU 크레딧이 소진되어 초과(surplus) 크레딧 과금이 발생. 전체 요청량 급증으로 애플리케이션 CPU 사용이 지속적으로 높은 상태.",
    action:
      "① Auto Scaling으로 인스턴스 수평 확장 ② 지속 고부하면 t3→c계열/상위 타입 전환 ③ T3 Unlimited 비용 검토 ④ 비정상 트래픽이면 ALB/WAF에서 차단",
    console:
      "CloudWatch → EC2 → CPUUtilization / CPUSurplusCreditsCharged. EC2 콘솔 → 인스턴스 → 모니터링 탭",
  },
  {
    id: "ALB_TRAFFIC_SPAM",
    title: "ALB 트래픽/커넥션 급증(LCU)",
    resourceType: "ALB",
    match: (c) => c.service === "elb",
    cause:
      "ALB의 LCU(신규 커넥션·활성 커넥션·처리 바이트·룰 평가) 급증. 전반적 요청 폭증 또는 커넥션 스파이크.",
    action:
      "① 백엔드 스케일아웃으로 커넥션 분산 ② keep-alive/커넥션 재사용 점검 ③ 비정상 소스면 WAF 차단 ④ 헬스체크·타깃 상태 확인",
    console:
      "CloudWatch → ApplicationELB → ConsumedLCUs·ActiveConnectionCount·RequestCount. EC2 콘솔 → 로드밸런서 → 모니터링",
  },
  {
    id: "SALE_EVENT",
    title: "다중 서비스 동시 비용 급증(세일/캠페인성)",
    resourceType: "Multiple",
    // 교차 서비스 조건: 이번 시간에 임계 초과한 서비스가 3개 이상이면 세일성으로 판정
    match: (c) =>
      Object.values(c.perService || {}).filter((v) => v > 0).length >= 3 &&
      c._anomalyCount >= 3,
    cause:
      "여러 서비스(CloudFront·ALB·EC2 등)가 동시에 상승. 특정 리소스 결함보다는 세일/마케팅 캠페인 같은 전사적 트래픽 급증 패턴.",
    action:
      "① 계획된 이벤트인지 먼저 확인(오탐 방지) ② 사전 스케줄 스케일링 적용 ③ 예산 알람·상한 점검 ④ 이벤트 종료 후 리소스 원복 확인",
    console:
      "FinOps 대시보드 → 비용 추이(전 서비스 동시 상승 여부). Cost Explorer → 서비스별 일별 그래프",
  },
  {
    id: "RDS_WRITE_SPAM",
    title: "RDS 쓰기 I/O 급증",
    resourceType: "RDS",
    match: (c) => c.service === "rds",
    cause:
      "RDS WriteIOPS·CPU 급증. 주문/쓰기 트랜잭션 폭주. (gp2 스토리지는 I/O 별도 과금이 없어 비용 기여는 작지만, 부하·장애 전조로 중요한 신호.)",
    action:
      "① 쓰기 쿼리/배치 점검 ② 커넥션 풀·슬로우 쿼리 확인 ③ 읽기는 리드 리플리카로 분산 ④ 지속되면 인스턴스 등급/스토리지 타입(gp3·io1) 재검토",
    console:
      "CloudWatch → RDS → WriteIOPS·ReadIOPS·CPUUtilization. RDS 콘솔 → 대상 DB → 모니터링 / Performance Insights",
  },
  // ---- 아래는 카탈로그 확장분(현재 주입 시나리오엔 없음, 신호 연결은 future work) ----
  {
    id: "DATA_EXFIL",
    title: "NAT 아웃바운드 전송 급증(데이터 유출 의심)",
    resourceType: "NAT",
    match: (c) => c.service === "ec2-other",
    cause:
      "NAT Gateway 아웃바운드 전송량 급증. 대량 외부 다운로드·업로드, 데이터 유출 또는 오설정된 배치 전송 가능성.",
    action:
      "① VPC Flow Logs로 목적지 IP·포트 확인 ② 비정상 목적지면 SG/NACL 차단 ③ S3 전송은 VPC Endpoint로 우회해 NAT 비용 제거 ④ 침해 의심 시 보안팀 에스컬레이션",
    console:
      "CloudWatch → NATGateway → BytesOutToDestination. VPC 콘솔 → Flow Logs. CloudTrail → 관련 이벤트",
  },
  {
    id: "S3_GET_SPAM",
    title: "S3 GET 요청 급증",
    resourceType: "S3",
    match: (c) => c.service === "s3",
    cause:
      "S3 GET 요청 급증. CloudFront 우회 직접 접근 또는 캐시 미적용 경로로 인한 요청 폭증 가능성.",
    action:
      "① CloudFront 경유로 캐싱 유도 ② 버킷 정책으로 직접 접근 제한 ③ 요청자 지불(Requester Pays) 검토",
    console:
      "CloudWatch → S3 → NumberOfObjects/Requests(요청 지표 활성화 시). S3 콘솔 → 버킷 → 지표",
  },
];

// ctx로 카탈로그를 평가해 매칭된 첫 규칙을 반환(없으면 서비스 기반 기본 규칙)
function matchRule(ctx) {
  for (const rule of RULE_CATALOG) {
    try {
      if (rule.match(ctx)) return rule;
    } catch {
      /* 규칙 평가 실패는 무시하고 다음 규칙 */
    }
  }
  return {
    id: "GENERIC",
    title: `${ctx.service} 비용 급증`,
    resourceType: ctx.service,
    cause: "평소 대비 비용이 통계적으로 유의하게 상승. 상세 원인 규칙 미매칭.",
    action: "해당 서비스의 CloudWatch 지표와 최근 배포/트래픽 변화를 점검.",
    console: "CloudWatch → 해당 서비스 네임스페이스에서 관련 지표 확인",
  };
}

// 하위호환: 기존 호출부가 쓰던 문자열 원인 힌트
function causeHint(service) {
  const rule = matchRule({ service, perService: {}, _anomalyCount: 1 });
  return rule.cause;
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

// 종합보고서(프론트 '종합보고서' 칸)에 그대로 실릴 서술형 텍스트 생성
function buildReportText({ company, service, rule, severity, z, mean, current, mode, n, hourKey, usage }) {
  const sevLabel = severity === "CRITICAL" ? "심각(CRITICAL)" : "경고(WARNING)";
  const pct = mean > 0 ? Math.round(((current - mean) / mean) * 100) : null;
  const lines = [
    `[${company} 비용 이상탐지 보고서] ${rule.title}`,
    ``,
    `■ 심각도: ${sevLabel} (z=${round2(z)}σ)`,
    `■ 대상 서비스: ${service} (${rule.resourceType})`,
    `■ 대상 시각(UTC): ${hourKey}`,
    `■ 비용 변화: 평소 추정 $${round2(mean)} → 이번 추정 $${round2(current)}` +
      (pct != null ? ` (약 ${pct >= 0 ? "+" : ""}${pct}%)` : ""),
    `■ 판정 근거: baseline(${mode === "seasonal" ? "동일 시간대 과거" : "최근 시간대 폴백"}, 표본 ${n}개)의 ` +
      `평균·표준편차 대비 ${round2(z)}σ 초과. 정규분포 가정상 ` +
      `${severity === "CRITICAL" ? "상위 0.003%" : "상위 2.3%"} 수준의 이례적 상승.`,
    ``,
    `■ 추정 원인`,
    `  ${rule.cause}`,
    ``,
    `■ 권장 조치`,
    `  ${rule.action}`,
    ``,
    `■ 콘솔 확인 경로`,
    `  ${rule.console}`,
    ``,
    `※ 본 판정은 CUR(실제청구) 도착 전 CloudWatch 지표 기반 실시간 추정치로 산출됨. ` +
      `익일 CUR 도착 시 reconciler가 실제값과 대조해 정확도(MAPE/WAPE)를 검증하고 보정계수를 갱신함.`,
  ];
  return lines.join("\n");
}

// 현재 시각 서비스별 추정치를 baseline 과 비교해 이상 탐지 → ALERT 기록 + 슬랙
// (규칙 카탈로그로 원인/조치/콘솔경로/보고서 텍스트를 함께 생성)
async function detectAndAlert(perService, dayUTC, hourKey, usage, endEpochSec) {
  const HH = hourKey.slice(11, 13);
  const seasonal = await buildBaseline(dayUTC, HH);
  let trailing = null; // 필요 시 지연 로딩

  const ttl = endEpochSec + ALERT_TTL_DAYS * 86400;

  // ── 1단계: 서비스별 z 계산 → 임계 초과분만 후보로 수집 ──
  //   (SALE_EVENT 등 "동시 다발" 교차 규칙 판정을 위해 먼저 전수 계산)
  const candidates = [];
  for (const [service, current] of Object.entries(perService)) {
    let samples = seasonal[service] || [];
    let mode = "seasonal";
    if (samples.length < MIN_SAMPLES) {
      if (!trailing) trailing = await trailingBaseline(dayUTC, hourKey);
      samples = trailing[service] || [];
      mode = "trailing";
    }
    if (samples.length < MIN_SAMPLES) continue; // 판단 불가

    const { n, mean, std } = stats(samples);
    if (std <= 0) continue; // 분산 0(고정비만) → 스킵
    const z = (current - mean) / std;
    const severity = severityOf(z);
    if (!severity) continue;

    candidates.push({ service, current, mean, std, z, severity, mode, n });
  }

  const anomalyCount = candidates.length; // 이번 시각 임계 초과 서비스 수(교차 규칙용)
  const nowIso = new Date().toISOString();
  const alerts = [];

  // ── 2단계: 후보마다 규칙 매칭 → ALERT 저장 + 슬랙 ──
  for (const c of candidates) {
    const rule = matchRule({
      service: c.service,
      z: c.z,
      severity: c.severity,
      current: c.current,
      expected: c.mean,
      usage,
      perService,
      _anomalyCount: anomalyCount,
    });

    const rawData = `${c.service} 시간당 추정 $${round2(c.current)} (baseline 평균 $${round2(c.mean)}, ${c.mode}, n=${c.n}, ${round2(c.z)}σ)`;
    const summary = `${rule.title} — ${c.service} 추정비용이 평소 대비 ${round2(c.z)}σ 상승`;
    const reportText = buildReportText({
      company: COMPANY_NAME, service: c.service, rule, severity: c.severity,
      z: c.z, mean: c.mean, current: c.current, mode: c.mode, n: c.n, hourKey, usage,
    });

    const alert = {
      service: c.service,
      ruleId: rule.id,
      title: rule.title,
      resourceType: rule.resourceType,
      severity: c.severity,
      z: round2(c.z),
      expected: round2(c.mean),
      actual: round2(c.current),
      baselineMode: c.mode,
      baselineN: c.n,
      cause: rule.cause,
      action: rule.action,
      console: rule.console,
    };
    alerts.push(alert);

    // ALERT 기록 (status=OPEN). 프론트 '이상 탐지 내역' + '종합보고서'가 읽는 필드 포함.
    await ddb.send(
      new PutItemCommand({
        TableName: DDB_TABLE,
        Item: marshall(
          {
            pk: "ALERT",
            sk: `${hourKey}#${c.service}`,
            type: "alert",
            status: "OPEN",
            company: COMPANY_NAME,
            service: c.service,
            ruleId: rule.id,
            title: rule.title,          // 프론트 Anomaly.title
            resourceType: rule.resourceType, // 프론트 Anomaly.resourceType
            severity: c.severity,
            z: round2(c.z),
            expected: round2(c.mean),
            actual: round2(c.current),
            detectedAt: nowIso,
            date: hourKey.slice(0, 10),  // 프론트 Anomaly.date (YYYY-MM-DD)
            hourUTC: hourKey,
            rawData,                     // 프론트 Anomaly.rawData
            summary,                     // 프론트 Anomaly.summary
            cause: rule.cause,           // 프론트 Anomaly.cause
            action: rule.action,         // 권장 조치
            consolePath: rule.console,   // 콘솔 확인 경로
            actionRequired: c.severity === "CRITICAL", // 프론트 Anomaly.actionRequired
            reportText,                  // 종합보고서 칸 서술형 텍스트
            ttl,
          },
          { removeUndefinedValues: true }
        ),
      })
    );

    // 슬랙 전송 (심각도·원인·조치·콘솔경로 포함)
    await notifySlack({
      company: COMPANY_NAME,
      severity: c.severity,
      service: c.service,
      rawData,
      summary,
      cause: `${rule.cause}\n\n▶ 권장 조치: ${rule.action}\n▶ 콘솔 확인: ${rule.console}`,
      actionRequired: c.severity === "CRITICAL",
      metric: { expected: round2(c.mean), actual: round2(c.current), z: round2(c.z), sigma: round2(c.z) },
      detectedAt: nowIso,
      hourUTC: hourKey,
    });
  }

  if (alerts.length) console.log(`[estimator] 이상 탐지 ${alerts.length}건`, alerts.map((a) => `${a.service}:${a.ruleId}(${a.severity},${a.z}σ)`));
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
