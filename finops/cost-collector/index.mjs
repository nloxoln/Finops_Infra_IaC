// cost-collector — 스케줄러가 하루 2번 실행.
// Cost Explorer 를 호출해 프론트가 바로 쓰는 형태 {summary, trend, resources} 를
// "계정별"로 계산하여 S3(cost-cache.json)에 저장한다. (조회기 cost-reader 는 이 캐시만 읽음)
//
// 캐시 구조:
//   { updatedAt, accounts: { "<accountId>": { summary, trend, resources } } }
//
// 계산 로직은 finops_dev/cost-api/index.mjs 와 동일 (프론트 계약과 1:1로 맞춤).

import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const ce = new CostExplorerClient({ region: "us-east-1" }); // CE 는 us-east-1
const s3 = new S3Client({});

const CACHE_BUCKET = process.env.CACHE_BUCKET;
const ACCOUNT_ID = process.env.ACCOUNT_ID; // 올리브영 계정 하나

// CUR/CE 서비스명을 그대로 사용 — 임의 매핑/'기타' 묶음 없이,
// 기간 내 비용이 발생한 모든 서비스를 원래 이름 그대로 개별 카드로 노출.
const toId = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

const toDateStr = (date) => date.toISOString().slice(0, 10);
const round2 = (n) => Math.round(n * 100) / 100;

const buildMonthlyRange = (monthsBack) => {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: toDateStr(start), end: toDateStr(end) };
};

const buildDailyRange = (daysBack) => {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - daysBack);
  return { start: toDateStr(start), end: toDateStr(end) };
};

async function computeForAccount(accountId) {
  const filter = accountId
    ? { Dimensions: { Key: "LINKED_ACCOUNT", Values: [accountId] } }
    : undefined;

  const monthly = buildMonthlyRange(2); // 이번달 포함 최근 3개월
  const daily = buildDailyRange(90); // 최근 90일(3달 뷰까지 커버)

  const [monthlyRes, dailyRes] = await Promise.all([
    ce.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: monthly.start, End: monthly.end },
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
        ...(filter ? { Filter: filter } : {}),
      })
    ),
    ce.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: daily.start, End: daily.end },
        Granularity: "DAILY",
        Metrics: ["UnblendedCost"],
        GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
        ...(filter ? { Filter: filter } : {}),
      })
    ),
  ]);

  // ── 1) 월별 합계 → 저번달/이번달/평균 ──
  const monthlyTotals = (monthlyRes.ResultsByTime || []).map((r) =>
    parseFloat(r.Total?.UnblendedCost?.Amount || "0")
  );
  const thisMonth = monthlyTotals[monthlyTotals.length - 1] || 0;
  const lastMonth = monthlyTotals[monthlyTotals.length - 2] || 0;
  const avgCost =
    monthlyTotals.length > 0 ? monthlyTotals.reduce((a, b) => a + b, 0) / monthlyTotals.length : 0;

  const summary = { lastMonth: round2(lastMonth), avgCost: round2(avgCost), thisMonth: round2(thisMonth) };

  // ── 2) 일별 → 전체 추이 + 서비스별 추이 ──
  const trendByDate = {};
  const resourceMap = {};

  for (const day of dailyRes.ResultsByTime || []) {
    const date = day.TimePeriod?.Start;
    for (const group of day.Groups || []) {
      const serviceName = group.Keys?.[0] || "";
      const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount || "0");
      if (cost === 0) continue;

      trendByDate[date] = (trendByDate[date] || 0) + cost;

      const id = toId(serviceName);
      if (!resourceMap[id]) resourceMap[id] = { id, name: serviceName, trend: {} };
      resourceMap[id].trend[date] = (resourceMap[id].trend[date] || 0) + cost;
    }
  }

  const trend = Object.entries(trendByDate)
    .map(([date, cost]) => ({ date, cost: round2(cost) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const resources = Object.values(resourceMap)
    .map(({ id, name, trend: t }) => ({
      id,
      name,
      type: name,
      costTrend: Object.entries(t)
        .map(([date, cost]) => ({ date, cost: round2(cost) }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    }))
    .sort((a, b) => {
      const sum = (arr) => arr.reduce((s, x) => s + x.cost, 0);
      return sum(b.costTrend) - sum(a.costTrend);
    });

  return { summary, trend, resources };
}

export const handler = async () => {
  if (!CACHE_BUCKET) throw new Error("CACHE_BUCKET 미설정");

  const accounts = {};
  accounts[ACCOUNT_ID] = await computeForAccount(ACCOUNT_ID);

  await s3.send(
    new PutObjectCommand({
      Bucket: CACHE_BUCKET,
      Key: "cost-cache.json",
      Body: JSON.stringify({ updatedAt: new Date().toISOString(), accounts }),
      ContentType: "application/json",
    })
  );

  console.log(`캐시 갱신 완료 (계정: ${ACCOUNT_ID}, 리소스 ${accounts[ACCOUNT_ID].resources.length}종)`);
  return { statusCode: 200, body: "ok" };
};
