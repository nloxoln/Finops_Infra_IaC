import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({});
const CACHE_BUCKET = process.env.CACHE_BUCKET;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export const handler = async (event) => {
  const accountId = event?.queryStringParameters?.accountId;

  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: CACHE_BUCKET, Key: "cost-cache.json" }));
    const body = JSON.parse(await obj.Body.transformToString());
    const resources = body.data[accountId] || [];

    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(resources) };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: "캐시를 아직 찾을 수 없어요. 잠시 후 다시 시도해주세요." }) };
  }
};