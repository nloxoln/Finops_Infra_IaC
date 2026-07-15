// index.mjs — reconciler (일별 보정기)
// Runtime: Node.js 20.x
//
// 매일 05:00 KST 에 EventBridge Scheduler 가 실행.
// Cost Explorer HOURLY 데이터는 반영에 ~48시간 걸리므로 T-2(이틀 전) 하루치를 대상으로 한다.
//   1) ce:GetCostAndUsage (HOURLY + SERVICE 그룹, LINKED_ACCOUNT 필터)로 "실제 비용"을 받고
//   2) DynamoDB 에 저장해둔 그날의 추정치(EST#)를 조인해
//   3) 서비스별 오차(MAPE)와 실제/추정 비율을 계산,
//   4) 보정계수를 EWMA 로 갱신(다음 추정에 반영)하고 정확도 리포트(ACC#)를 남긴다.
//
// 저장 최소화: CUR/Athena 를 쓰지 않는다(원본 스캔·보관 없음). CUR 는 월간 종합보고서 전용.

import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { DynamoDBClient, QueryCommand, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const REGION = process.env.REGION || "ap-northeast-2";
const ce = new CostExplorerClient({ region: "us-east-1" }); // CE 는 us-east-1
const ddb = new DynamoDBClient({ region: REGION });

const DDB_TABLE = process.env.DDB_TABLE;
const ACCOUNT_ID = process.env.ACCOUNT_ID; // 올리브영 계정
const LEARNING_RATE = Number(process.env.LEARNING_RATE || 0.3);
const RECONCILE_LAG_DAYS = Number(process.env.RECONCILE_LAG_DAYS || 2); // 기본 T-2 (CE 지연 대응)
const COEFF_MIN = 0.2;
const COEFF_MAX = 5;

const round4 = (n) => Math.round(n * 1e4) / 1e4;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Cost Explorer 서비스명 → 내부 서비스 id (추정기와 동일 체계)
// 주의: "EC2 - Other"(NAT/EBS/EIP) 와 "…Compute"(인스턴스) 를 반드시 분리.
const CE_SERVICE_MAP = [
  { match: /EC2\s*-\s*Other/i, id: "ec2-other" },
  { match: /Elastic Compute Cloud/i, id: "ec2" },
  { match: /Relational Database/i, id: "rds" },
  { match: /CloudFront/i, id: "cloudfront" },
  { match: /Simple Storage Service|(^|\W)S3(\W|$)/i, id: "s3" },
  { match: /Route\s*53/i, id: "route53" },
  { match: /Elastic Load Balancing/i, id: "elb" },
];
const classify = (name) => CE_SERVICE_MAP.find((m) => m.match.test(name))?.id || null;

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

async function putCoeff(service, coeff, iso) {
  await ddb.send(
    new PutItemCommand({
      TableName: DDB_TABLE,
      Item: marshall({ pk: "COEF", sk: service, coeff: round4(coeff), updatedAt: iso }),
    })
  );
}

export const handler = async (event = {}) => {
  if (!DDB_TABLE) throw new Error("DDB_TABLE 미설정");
  if (!ACCOUNT_ID) throw new Error("ACCOUNT_ID 미설정");

  // 대상 하루 [start, end) UTC
  // - 평상시: T-N (기본 N=2, CE 지연 대응)
  // - 데모용: event.targetDay("YYYY-MM-DD") 를 주면 그 날짜를 즉시 보정
  const now = new Date();
  let start;
  if (event.targetDay) {
    start = new Date(`${event.targetDay}T00:00:00Z`);
    if (Number.isNaN(start.getTime())) throw new Error(`잘못된 targetDay: ${event.targetDay}`);
  } else {
    const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    start = new Date(todayUTC - RECONCILE_LAG_DAYS * 86400000);
  }
  const end = new Date(start.getTime() + 86400000);
  const day = start.toISOString().slice(0, 10);
  const startISO = start.toISOString().slice(0, 19) + "Z"; // 2026-07-13T00:00:00Z
  const endISO = end.toISOString().slice(0, 19) + "Z";

  // ── 1) 실제 비용 (CE HOURLY, 서비스별) ──
  const res = await ce.send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: startISO, End: endISO },
      Granularity: "HOURLY",
      Metrics: ["UnblendedCost"],
      GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
      Filter: { Dimensions: { Key: "LINKED_ACCOUNT", Values: [ACCOUNT_ID] } },
    })
  );

  const actual = {}; // service -> 하루 합계
  for (const t of res.ResultsByTime || []) {
    for (const g of t.Groups || []) {
      const id = classify(g.Keys?.[0] || "");
      if (!id) continue;
      const c = parseFloat(g.Metrics?.UnblendedCost?.Amount || "0");
      actual[id] = (actual[id] || 0) + c;
    }
  }

  // ── 2) 저장된 추정치 (그날의 EST#) ──
  const q = await ddb.send(
    new QueryCommand({
      TableName: DDB_TABLE,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: marshall({ ":pk": `EST#${day}` }),
    })
  );
  const est = {}; // service -> {fixed, variable, estimated}
  for (const raw of q.Items || []) {
    const it = unmarshall(raw);
    if (it.type !== "estimate") continue;
    const s = it.service;
    if (!est[s]) est[s] = { fixed: 0, variable: 0, estimated: 0 };
    est[s].fixed += it.fixed || 0;
    est[s].variable += it.variable || 0;
    est[s].estimated += it.estimated || 0;
  }

  // ── 3) 서비스별 조인 → 오차·비율 → 4) 보정계수 EWMA 갱신 ──
  const iso = now.toISOString();
  const services = Array.from(new Set([...Object.keys(est), ...Object.keys(actual)]));
  const report = [];
  let sumActual = 0;
  let sumAbsErr = 0;

  for (const s of services) {
    const e = est[s] || { fixed: 0, variable: 0, estimated: 0 };
    const a = actual[s] || 0;
    const estimatedTotal = e.estimated;
    const absErr = Math.abs(a - estimatedTotal);
    const mape = a > 0 ? round4(absErr / a) : null;
    sumActual += a;
    sumAbsErr += absErr;

    const oldCoeff = await getCoeff(s);
    let newCoeff = oldCoeff;

    // 변동비만 계수로 보정. e.variable 은 이미 oldCoeff 가 곱해진 값이므로
    //   단가×사용량 = e.variable / oldCoeff,  목표계수 = 실제변동비 / (단가×사용량)
    const actualVar = a - e.fixed;
    if (e.variable > 0 && actualVar > 0 && oldCoeff > 0) {
      const desired = (actualVar * oldCoeff) / e.variable;
      newCoeff = clamp(oldCoeff * (1 - LEARNING_RATE) + desired * LEARNING_RATE, COEFF_MIN, COEFF_MAX);
      await putCoeff(s, newCoeff, iso);
    }

    const row = {
      pk: `ACC#${day}`,
      sk: s,
      type: "accuracy",
      service: s,
      day,
      actual: round4(a),
      estimated: round4(estimatedTotal),
      fixed: round4(e.fixed),
      mape,
      ratio: estimatedTotal > 0 ? round4(a / estimatedTotal) : null,
      oldCoeff: round4(oldCoeff),
      newCoeff: round4(newCoeff),
      updatedAt: iso,
    };
    await ddb.send(new PutItemCommand({ TableName: DDB_TABLE, Item: marshall(row, { removeUndefinedValues: true }) }));
    report.push(row);
  }

  // 전체 정확도 요약 (WAPE = Σ|오차| / Σ실제)
  const overallWape = sumActual > 0 ? round4(sumAbsErr / sumActual) : null;
  await ddb.send(
    new PutItemCommand({
      TableName: DDB_TABLE,
      Item: marshall(
        { pk: `ACC#${day}`, sk: "__overall", type: "accuracy", day, sumActual: round4(sumActual), wape: overallWape, updatedAt: iso },
        { removeUndefinedValues: true }
      ),
    })
  );

  console.log(`[reconciler] ${day} 보정 완료: WAPE=${overallWape}`, report.map((r) => ({ s: r.service, mape: r.mape, coeff: r.newCoeff })));
  return { statusCode: 200, body: JSON.stringify({ day, wape: overallWape, services: report }) };
};
