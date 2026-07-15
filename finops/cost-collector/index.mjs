import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const ce = new CostExplorerClient({ region: "us-east-1" });
const s3 = new S3Client({});
const CACHE_BUCKET = process.env.CACHE_BUCKET;
const KRW_TO_USD_RATE = Number(process.env.KRW_TO_USD_RATE || 1350);
const ACCOUNT_ID = process.env.ACCOUNT_ID; // 429500963680 하나만

const toId = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

export const handler = async () => {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 400); // 1년 뷰까지 커버
  const fmt = (d) => d.toISOString().split("T")[0];

  const res = await ce.send(new GetCostAndUsageCommand({
    TimePeriod: { Start: fmt(start), End: fmt(end) },
    Granularity: "DAILY",
    Metrics: ["UnblendedCost"],
    GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
    Filter: { Dimensions: { Key: "LINKED_ACCOUNT", Values: [ACCOUNT_ID] } },
  }));

  const resources = {};
  for (const day of res.ResultsByTime ?? []) {
    const date = day.TimePeriod.Start;
    for (const group of day.Groups ?? []) {
      const unit = group.Metrics.UnblendedCost.Unit;
      let cost = parseFloat(group.Metrics.UnblendedCost.Amount);
      if (unit === "KRW") cost = cost / KRW_TO_USD_RATE;
      if (cost === 0) continue;

      const id = toId(group.Keys[0]);
      if (!resources[id]) {
        resources[id] = { id, name: group.Keys[0], type: group.Keys[0], costTrend: [] };
      }
      resources[id].costTrend.push({ date, cost });
    }
  }

  await s3.send(new PutObjectCommand({
    Bucket: CACHE_BUCKET,
    Key: "cost-cache.json",
    Body: JSON.stringify({ updatedAt: new Date().toISOString(), data: Object.values(resources) }),
    ContentType: "application/json",
  }));

  console.log(`캐시 갱신 완료 (계정: ${ACCOUNT_ID})`);
};