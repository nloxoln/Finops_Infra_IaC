// index.mjs — reconciler (일별 보정기) · CUR(CSV/GZIP) 기반 · KST 창(window) 지원
// Runtime: Node.js 20.x  (AWS SDK v3 런타임 내장, 외부 의존성 없음)
//
// [변경 배경]
//   CUR·EST# 는 전부 UTC 로 저장됨. 분석 대상이 "KST 특정 시각 이후"인 경우
//   UTC day 하나로는 잡히지 않는다(예: KST 7/16 08:00 = UTC 7/15 23:00).
//   → fromKST(시작 KST 시각)와 hours(창 길이)를 받아, 걸치는 UTC 날짜들의
//     CUR + EST# 를 모두 읽고 [fromUTC, toUTC) 구간만 집계한다.
//
// payload 예:
//   {"fromKST":"2026-07-16T08:00","hours":24}   ← KST 7/16 08시부터 24시간
//   {"day":"2026-07-14"}                          ← (호환) 그날 UTC 00~24시
//   (없으면) T-2 하루치 UTC
//
// 저장 최소화: CUR 원본은 S3 lifecycle 로 자동 만료. 여기선 읽기만 하고
//              집계 결과(ACC#/COEF#)만 DynamoDB 에 남긴다.

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient, QueryCommand, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { gunzipSync } from "node:zlib";

const REGION = process.env.REGION || "ap-northeast-2";
const s3 = new S3Client({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });

const DDB_TABLE = process.env.DDB_TABLE;

// ---- CUR 위치 ----
const CUR_BUCKET = process.env.CUR_BUCKET;
const CUR_PREFIX = process.env.CUR_PREFIX || "cur";
const CUR_REPORT = process.env.CUR_REPORT || "cost-poc-cur";

// ---- 보정 파라미터 ----
const LEARNING_RATE = Number(process.env.LEARNING_RATE || 0.3);
const RECONCILE_LAG_DAYS = Number(process.env.RECONCILE_LAG_DAYS || 2);
const COEFF_MIN = Number(process.env.COEFF_MIN || 0.1);
const COEFF_MAX = Number(process.env.COEFF_MAX || 20);
const KST_OFFSET_H = 9; // KST = UTC + 9

const FINOPS_MARKERS = (process.env.FINOPS_MARKERS ||
  "finops-estimator,finops-reconciler,finops-cost-collector,finops-cost-reader,finops-cost-estimates,finops-cost-cache,finops-cur,cost-collector-scheduler,estimator-scheduler,reconciler-schedule"
).split(",").map((s) => s.trim()).filter(Boolean);

const KEEP_TYPES = new Set(["Usage", "DiscountedUsage", "SavingsPlanCoveredUsage"]);

const round4 = (n) => Math.round(n * 1e4) / 1e4;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function mapService(productCode, usageType, productName) {
  const pc = (productCode || "").toLowerCase();
  const ut = (usageType || "").toLowerCase();
  const pn = (productName || "").toLowerCase();
  if (pc.includes("elb") || pn.includes("load balancing")) return "elb";
  if (pc.includes("cloudfront") || pn.includes("cloudfront")) return "cloudfront";
  if (pc.includes("rds") || pn.includes("relational database")) return "rds";
  if (pc === "amazons3" || pn.includes("simple storage")) return "s3";
  if (pc.includes("route53") || pn.includes("route 53")) return "route53";
  if (pc === "amazonec2" || pn.includes("elastic compute cloud")) {
    if (ut.includes("natgateway") || ut.includes("ebs") || ut.includes("volumeusage") ||
        ut.includes("snapshot") || ut.includes("elasticip") || ut.includes("address")) return "ec2-other";
    if (ut.includes("boxusage") || ut.includes("spotusage") || ut.includes("dedicated") ||
        ut.includes("cpucredit") || ut.includes("reservation")) return "ec2";
    return "ec2-other";
  }
  return "others";
}

const isFinopsResource = (rid) => {
  if (!rid) return false;
  const low = rid.toLowerCase();
  return FINOPS_MARKERS.some((m) => low.includes(m.toLowerCase()));
};

// ---- 시간 유틸 ----
const utcDayStr = (d) => d.toISOString().slice(0, 10);        // YYYY-MM-DD
const utcHourStr = (d) => d.toISOString().slice(0, 13);       // YYYY-MM-DDTHH

// 창(window)이 걸치는 UTC 날짜 목록 (CUR/EST 읽을 날짜들)
function utcDaysInWindow(fromUTC, toUTC) {
  const days = new Set();
  for (let t = Date.UTC(fromUTC.getUTCFullYear(), fromUTC.getUTCMonth(), fromUTC.getUTCDate());
       t < toUTC.getTime(); t += 86400000) {
    days.add(utcDayStr(new Date(t)));
  }
  // toUTC 가 자정 정각이 아니면 마지막 날도 포함되도록 보정
  days.add(utcDayStr(fromUTC));
  days.add(utcDayStr(new Date(toUTC.getTime() - 1)));
  return Array.from(days).sort();
}

// 대상일이 속한 청구 기간 폴더명: YYYYMMDD-YYYYMMDD
function billingPeriodFolder(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  const fmt = (x) => x.toISOString().slice(0, 10).replace(/-/g, "");
  return `${fmt(start)}-${fmt(end)}`;
}

async function getObjectBuffer(bucket, key) {
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks = [];
  for await (const c of obj.Body) chunks.push(c);
  return Buffer.concat(chunks);
}

async function readReportKeys(period) {
  const manifestKey = `${CUR_PREFIX}/${CUR_REPORT}/${period}/${CUR_REPORT}-Manifest.json`;
  const buf = await getObjectBuffer(CUR_BUCKET, manifestKey);
  const manifest = JSON.parse(buf.toString("utf-8"));
  return manifest.reportKeys || [];
}

function parseCsvLine(line) {
  const out = []; let cur = ""; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// CSV 를 파싱해 [fromUTC, toUTC) 구간만 actual 에 누적
function accumulateCsv(csvText, fromUTC, toUTC, actualHour, actualDay) {
  const lines = csvText.split("\n");
  if (lines.length < 2) return;
  const header = parseCsvLine(lines[0]);
  const idx = (name) => header.indexOf(name);
  const iStart = idx("lineItem/UsageStartDate");
  const iType = idx("lineItem/LineItemType");
  const iProd = idx("lineItem/ProductCode");
  const iUsage = idx("lineItem/UsageType");
  const iRid = idx("lineItem/ResourceId");
  const iCost = idx("lineItem/UnblendedCost");
  const iPName = idx("product/ProductName");
  if (iStart < 0 || iCost < 0) { console.warn("CUR 헤더 컬럼 못 찾음:", header.slice(0, 10)); return; }

  for (let r = 1; r < lines.length; r++) {
    if (!lines[r]) continue;
    const cols = parseCsvLine(lines[r]);
    const startStr = cols[iStart];
    if (!startStr) continue;
    const startT = new Date(startStr).getTime();          // CUR UsageStartDate 는 UTC
    if (!(startT >= fromUTC.getTime() && startT < toUTC.getTime())) continue; // ★ KST 창 필터

    const type = iType >= 0 ? cols[iType] : "Usage";
    if (!KEEP_TYPES.has(type)) continue;
    const rid = iRid >= 0 ? cols[iRid] : "";
    if (isFinopsResource(rid)) continue;
    const cost = parseFloat(cols[iCost] || "0");
    if (!Number.isFinite(cost) || cost === 0) continue;

    const svc = mapService(iProd >= 0 ? cols[iProd] : "", iUsage >= 0 ? cols[iUsage] : "", iPName >= 0 ? cols[iPName] : "");
    const hour = utcHourStr(new Date(startT));
    (actualHour[hour] ||= {});
    actualHour[hour][svc] = (actualHour[hour][svc] || 0) + cost;
    actualDay[svc] = (actualDay[svc] || 0) + cost;
  }
}

async function getCoeff(service) {
  try {
    const r = await ddb.send(new GetItemCommand({ TableName: DDB_TABLE, Key: marshall({ pk: "COEF", sk: service }) }));
    if (r.Item) { const c = Number(unmarshall(r.Item).coeff); if (Number.isFinite(c) && c > 0) return c; }
  } catch (e) { console.warn(`보정계수 조회 실패(${service}):`, e.message); }
  return 1;
}
async function putCoeff(service, coeff, iso) {
  await ddb.send(new PutItemCommand({
    TableName: DDB_TABLE,
    Item: marshall({ pk: "COEF", sk: service, type: "coeff", service, coeff: round4(coeff), updatedAt: iso }),
  }));
}

// 여러 UTC 날짜의 EST# 를 읽어 [fromUTC,toUTC) 시간대만 서비스별 합산
async function loadEstimatesInWindow(utcDays, fromUTC, toUTC) {
  const est = {}; // service -> {fixed, variable, estimated}
  for (const day of utcDays) {
    const q = await ddb.send(new QueryCommand({
      TableName: DDB_TABLE,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: marshall({ ":pk": `EST#${day}` }),
    }));
    for (const raw of q.Items || []) {
      const it = unmarshall(raw);
      if (it.type !== "estimate") continue;
      // it.hourUTC = "YYYY-MM-DDTHH" → 창 안인지 확인
      const hT = new Date(`${it.hourUTC}:00:00Z`).getTime();
      if (!(hT >= fromUTC.getTime() && hT < toUTC.getTime())) continue;
      const s = it.service;
      (est[s] ||= { fixed: 0, variable: 0, estimated: 0 });
      est[s].fixed += it.fixed || 0;
      est[s].variable += it.variable || 0;
      est[s].estimated += it.estimated || 0;
    }
  }
  return est;
}

export const handler = async (event) => {
  const now = new Date();
  const iso = now.toISOString();

  // ── 대상 창 결정 ──
  let fromUTC, toUTC, label;
  if (event?.fromKST) {
    // KST 시각 → UTC (KST - 9h). event.fromKST 예: "2026-07-16T08:00"
    const kstMs = new Date(`${event.fromKST}:00+09:00`).getTime();
    fromUTC = new Date(kstMs);
    const hours = Number(event.hours || 24);
    toUTC = new Date(kstMs + hours * 3600000);
    label = `KST ${event.fromKST}(+${hours}h)`;
  } else {
    const day = event?.day || utcDayStr(new Date(now.getTime() - RECONCILE_LAG_DAYS * 86400000));
    fromUTC = new Date(`${day}T00:00:00Z`);
    toUTC = new Date(fromUTC.getTime() + 86400000);
    label = `UTC ${day}`;
  }

  const utcDays = utcDaysInWindow(fromUTC, toUTC);
  const periods = Array.from(new Set(utcDays.map(billingPeriodFolder)));
  console.log(`[reconciler] 대상=${label}  UTC창=[${fromUTC.toISOString()}, ${toUTC.toISOString()})  날짜=${utcDays} 기간=${periods}`);

  // ── 1) CUR 읽어 실제 비용 집계 ──
  const actualHour = {};
  const actualDay = {};
  for (const period of periods) {
    let keys = [];
    try { keys = await readReportKeys(period); }
    catch (e) { console.warn(`manifest 조회 실패(${period}):`, e.message); continue; }
    for (const key of keys) {
      try {
        const gz = await getObjectBuffer(CUR_BUCKET, key);
        accumulateCsv(gunzipSync(gz).toString("utf-8"), fromUTC, toUTC, actualHour, actualDay);
      } catch (e) { console.warn(`CUR 파일 처리 실패(${key}):`, e.message); }
    }
  }
  const hoursSeen = Object.keys(actualHour).length;

  // ── 2) 추정치(EST#) 창 안에서 로드 ──
  const est = await loadEstimatesInWindow(utcDays, fromUTC, toUTC);

  // ── 3) 조인 → 4) 계수 EWMA 갱신 ──
  const services = Array.from(new Set([...Object.keys(est), ...Object.keys(actualDay)]));
  const report = [];
  let sumActual = 0, sumAbsErr = 0;
  const accPk = `ACC#${event?.fromKST ? event.fromKST : (event?.day || utcDayStr(fromUTC))}`;

  for (const s of services) {
    if (s === "others") { sumActual += actualDay[s] || 0; continue; }
    const e = est[s] || { fixed: 0, variable: 0, estimated: 0 };
    const a = actualDay[s] || 0;
    const estimatedTotal = e.estimated;
    const absErr = Math.abs(a - estimatedTotal);
    const mape = a > 0 ? round4(absErr / a) : null;
    sumActual += a; sumAbsErr += absErr;

    const oldCoeff = await getCoeff(s);
    let newCoeff = oldCoeff;
    // 통합 coeff 모델: base(=고정비+변동비, pre-coeff)에 coeff 를 곱해 서비스 전체를 스케일.
    // estimator 가 variable 을 pre-coeff(raw)로 저장하므로 e.fixed+e.variable 이 곧 base.
    // → 고정비만 있는 서비스(rds/route53 등)도 base>0 이면 갱신되어 실제값에 수렴한다.
    const base = e.fixed + e.variable;
    if (base > 0 && a > 0 && oldCoeff > 0) {
      const desired = a / base; // 이 창을 정확히 맞추는 coeff
      newCoeff = clamp(oldCoeff * (1 - LEARNING_RATE) + desired * LEARNING_RATE, COEFF_MIN, COEFF_MAX);
      await putCoeff(s, newCoeff, iso);
    }
    const row = {
      pk: accPk, sk: s, type: "accuracy", service: s, window: label,
      actual: round4(a), estimated: round4(estimatedTotal), fixed: round4(e.fixed),
      mape, ratio: estimatedTotal > 0 ? round4(a / estimatedTotal) : null,
      oldCoeff: round4(oldCoeff), newCoeff: round4(newCoeff), updatedAt: iso,
    };
    await ddb.send(new PutItemCommand({ TableName: DDB_TABLE, Item: marshall(row, { removeUndefinedValues: true }) }));
    report.push(row);
  }

  const overallWape = sumActual > 0 ? round4(sumAbsErr / sumActual) : null;
  await ddb.send(new PutItemCommand({
    TableName: DDB_TABLE,
    Item: marshall({ pk: accPk, sk: "__overall", type: "accuracy", window: label, sumActual: round4(sumActual), wape: overallWape, hoursSeen, updatedAt: iso }, { removeUndefinedValues: true }),
  }));

  console.log(`[reconciler] ${label} 보정완료: WAPE=${overallWape}, 시간수=${hoursSeen}`,
    report.map((r) => ({ s: r.service, actual: r.actual, est: r.estimated, mape: r.mape, coeff: r.newCoeff })));
  return { statusCode: 200, body: JSON.stringify({ window: label, wape: overallWape, hoursSeen, services: report }) };
};













