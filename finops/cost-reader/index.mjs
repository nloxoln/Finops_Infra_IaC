// cost-reader — API Gateway(GET /cost)가 호출. S3 캐시(cost-cache.json)만 읽어
// 해당 accountId 의 {summary, trend, resources} 를 그대로 반환한다. (CE 호출 없음 → 즉시 응답)

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({});
const CACHE_BUCKET = process.env.CACHE_BUCKET;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

// 캐시가 아직 없거나 해당 계정 데이터가 없을 때의 기본값 (프론트가 0 으로 표시)
const EMPTY = { summary: { lastMonth: 0, avgCost: 0, thisMonth: 0 }, trend: [], resources: [] };

export const handler = async (event) => {
  const accountId = event?.queryStringParameters?.accountId;

  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: CACHE_BUCKET, Key: "cost-cache.json" }));
    const body = JSON.parse(await obj.Body.transformToString());
    const data = (accountId && body.accounts?.[accountId]) || EMPTY;

    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(data) };
  } catch (err) {
    // 캐시 파일이 아직 없을 수 있음 → 빈 데이터로 200 응답(프론트 에러 방지)
    console.warn("캐시 조회 실패:", err.message);
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(EMPTY) };
  }
};
