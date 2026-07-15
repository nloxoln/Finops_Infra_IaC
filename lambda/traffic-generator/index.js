// index.js — traffic-generator (정상 베이스라인 트래픽 생성기)
// Runtime: Node.js 20.x  (AWS SDK v3 + global fetch 내장)

const ALB_ENDPOINT = process.env.ALB_ENDPOINT;   // 예: http://app-alb-xxxx.ap-northeast-2.elb.amazonaws.com
const CF_DOMAIN = process.env.CLOUDFRONT_DOMAIN; // 예: dxxxx.cloudfront.net
const LOG_BUCKET = process.env.LOG_BUCKET;       // ground-truth 로그 저장용 S3 버킷명

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const s3 = new S3Client({});

// 시간대별 강도 (KST 기준, 09~18시) — 점심 12시 / 퇴근 18시 이중 피크
const INTENSITY_BY_HOUR = {
  9: 0.20, 10: 0.30, 11: 0.45, 12: 0.90, 13: 0.65,
  14: 0.40, 15: 0.50, 16: 0.60, 17: 0.80, 18: 1.00,
};

const ROUTE_WEIGHTS = [
  { path: "/api/products", weight: 0.6 },
  { path: "/api/cart",     weight: 0.2 },
  { path: "/api/orders",   weight: 0.1 },
  { path: "/api/auth",     weight: 0.1 },
];

// 인기상품(캐시 히트 유도) / 롱테일상품(캐시 미스 유도)
// olive-product 버킷에는 products/1.png ~ products/16.png 만 실제 존재.
//  - 인기상품 = 1~16 (존재 → 두 번째 요청부터 캐시 HIT)
//  - 롱테일   = 17~9999 랜덤 (파일 없음 → 404 + 캐시 MISS 유도)
const POPULAR_PRODUCT_IDS = Array.from({ length: 16 }, (_, i) => i + 1);
const LONGTAIL_PRODUCT_ID_RANGE = [17, 9999];

const BASE_REQUESTS_PER_RUN = 1000; // 12분당 기본 요청 수 

function pickWeightedRoute() {
  const r = Math.random();
  let acc = 0;
  for (const rt of ROUTE_WEIGHTS) {
    acc += rt.weight;
    if (r <= acc) return rt.path;
  }
  return ROUTE_WEIGHTS[ROUTE_WEIGHTS.length - 1].path;
}

function pickProductId() {
  // 80% 인기상품(히트유도), 20% 롱테일(미스유도)
  if (Math.random() < 0.8) {
    return POPULAR_PRODUCT_IDS[Math.floor(Math.random() * POPULAR_PRODUCT_IDS.length)];
  }
  const [min, max] = LONGTAIL_PRODUCT_ID_RANGE;
  return min + Math.floor(Math.random() * (max - min));
}

async function callApi(path) {
  const start = Date.now();
  try {
    const res = await fetch(`${ALB_ENDPOINT}${path}`, { method: "GET" });
    return { path, status: res.status, latencyMs: Date.now() - start };
  } catch (err) {
    return { path, status: "ERROR", error: err.message, latencyMs: Date.now() - start };
  }
}

async function callCloudFrontImage(productId) {
  // cloudfront.tf 의 ordered_cache_behavior path_pattern = "/products/*" (images-origin) 과 일치
  // 실제 파일은 .png, 키 형태 products/{숫자}.png
  const url = `https://${CF_DOMAIN}/products/${productId}.png`;
  const start = Date.now();
  try {
    const res = await fetch(url, { method: "GET" });
    return {
      path: `image:${productId}`,
      status: res.status,
      cacheResult: res.headers.get("x-cache") || "unknown", // Hit/Miss from cloudfront
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return { path: `image:${productId}`, status: "ERROR", error: err.message, latencyMs: Date.now() - start };
  }
}

exports.handler = async () => {
  const nowUTC = new Date();
  const nowKST = new Date(nowUTC.getTime() + 9 * 3600 * 1000);
  const hour = nowKST.getUTCHours();
  const intensity = INTENSITY_BY_HOUR[hour] ?? 0.1;
  const noise = 1 + (Math.random() * 0.3 - 0.15); // ±15%
  const totalRequests = Math.max(1, Math.round(BASE_REQUESTS_PER_RUN * intensity * noise));

  const runLog = {
    scenario: "normal",
    timestampKST: nowKST.toISOString(),
    hour,
    intensity,
    totalRequests,
    calls: [],
  };

  for (let i = 0; i < totalRequests; i++) {
    const path = pickWeightedRoute();
    const apiResult = await callApi(path);
    runLog.calls.push(apiResult);

    if (path === "/api/products") {
      const productId = pickProductId();
      const imgResult = await callCloudFrontImage(productId);
      runLog.calls.push(imgResult);
    }
  }

  const key = `traffic-logs/normal/${nowKST.toISOString().slice(0, 10)}/${nowKST.getTime()}.json`;
  await s3.send(new PutObjectCommand({
    Bucket: LOG_BUCKET,
    Key: key,
    Body: JSON.stringify(runLog, null, 2),
    ContentType: "application/json",
  }));

  console.log(`[normal] hour=${hour} intensity=${intensity.toFixed(2)} requests=${totalRequests}`);
  return { statusCode: 200, body: JSON.stringify({ totalRequests }) };
};
