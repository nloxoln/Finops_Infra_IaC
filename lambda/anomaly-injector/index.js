// index.js — anomaly-injector (이상 비용 시나리오 주입기)
// Runtime: Node.js 20.x
// ANOMALY_TYPE 환경변수로 4종 전환:
//   "CACHE_MISS_SPAM" | "RDS_WRITE_SPAM" | "EC2_LOAD_SPAM" | "SALE_EVENT"

const ALB_ENDPOINT = process.env.ALB_ENDPOINT;
const CF_DOMAIN = process.env.CLOUDFRONT_DOMAIN;
const LOG_BUCKET = process.env.LOG_BUCKET;
const ANOMALY_TYPE = process.env.ANOMALY_TYPE || "CACHE_MISS_SPAM";
const ANOMALY_MULTIPLIER = Number(process.env.ANOMALY_MULTIPLIER || "5"); // 요청량 배수

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const s3 = new S3Client({});

const BASE_REQUESTS_PER_RUN = 15;

// olive-product 버킷에는 products/1.png ~ products/16.png 만 실제 존재.
const POPULAR_PRODUCT_IDS = Array.from({ length: 16 }, (_, i) => i + 1);
const LONGTAIL_PRODUCT_ID_RANGE = [17, 9999];

// 시나리오별 라우트 가중치 + 상품 선택 로직 오버라이드
const SCENARIOS = {
  CACHE_MISS_SPAM: {
    routeWeights: [
      { path: "/api/products", weight: 0.9 },
      { path: "/api/cart",     weight: 0.05 },
      { path: "/api/orders",   weight: 0.0 },
      { path: "/api/auth",     weight: 0.05 },
    ],
    longtailRatio: 0.9, // 정상 0.2 → 0.9 로 뒤집어 캐시 미스 폭증
    multiplier: ANOMALY_MULTIPLIER,
  },
  RDS_WRITE_SPAM: {
    routeWeights: [
      { path: "/api/products", weight: 0.15 },
      { path: "/api/cart",     weight: 0.15 },
      { path: "/api/orders",   weight: 0.65 }, // 쓰기 폭증
      { path: "/api/auth",     weight: 0.05 },
    ],
    longtailRatio: 0.2,
    multiplier: ANOMALY_MULTIPLIER,
  },
  EC2_LOAD_SPAM: {
    routeWeights: [
      { path: "/api/products", weight: 0.6 },
      { path: "/api/cart",     weight: 0.2 },
      { path: "/api/orders",   weight: 0.1 },
      { path: "/api/auth",     weight: 0.1 },
    ],
    longtailRatio: 0.2,
    multiplier: ANOMALY_MULTIPLIER * 2, // 전체 요청량 자체를 크게
  },
  SALE_EVENT: { // 교차 리소스형 — 전부 동시 증가
    routeWeights: [
      { path: "/api/products", weight: 0.5 },
      { path: "/api/cart",     weight: 0.25 },
      { path: "/api/orders",   weight: 0.2 },
      { path: "/api/auth",     weight: 0.05 },
    ],
    longtailRatio: 0.5,
    multiplier: ANOMALY_MULTIPLIER,
  },
};

function pickWeightedRoute(weights) {
  const r = Math.random();
  let acc = 0;
  for (const rt of weights) {
    acc += rt.weight;
    if (r <= acc) return rt.path;
  }
  return weights[weights.length - 1].path;
}

function pickProductId(longtailRatio) {
  if (Math.random() < longtailRatio) {
    const [min, max] = LONGTAIL_PRODUCT_ID_RANGE;
    return min + Math.floor(Math.random() * (max - min));
  }
  return POPULAR_PRODUCT_IDS[Math.floor(Math.random() * POPULAR_PRODUCT_IDS.length)];
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
  const url = `https://${CF_DOMAIN}/products/${productId}.png`;
  const start = Date.now();
  try {
    const res = await fetch(url, { method: "GET" });
    return {
      path: `image:${productId}`,
      status: res.status,
      cacheResult: res.headers.get("x-cache") || "unknown",
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return { path: `image:${productId}`, status: "ERROR", error: err.message, latencyMs: Date.now() - start };
  }
}

exports.handler = async () => {
  const scenario = SCENARIOS[ANOMALY_TYPE];
  if (!scenario) throw new Error(`Unknown ANOMALY_TYPE: ${ANOMALY_TYPE}`);

  const nowUTC = new Date();
  const nowKST = new Date(nowUTC.getTime() + 9 * 3600 * 1000);
  const totalRequests = Math.round(BASE_REQUESTS_PER_RUN * scenario.multiplier);

  const runLog = {
    scenario: "anomaly",
    anomalyType: ANOMALY_TYPE,
    timestampKST: nowKST.toISOString(), // ground truth: 이상 발생 시각
    totalRequests,
    calls: [],
  };

  for (let i = 0; i < totalRequests; i++) {
    const path = pickWeightedRoute(scenario.routeWeights);
    const apiResult = await callApi(path);
    runLog.calls.push(apiResult);

    if (path === "/api/products") {
      const productId = pickProductId(scenario.longtailRatio);
      const imgResult = await callCloudFrontImage(productId);
      runLog.calls.push(imgResult);
    }
  }

  // ground-truth 로그는 별도 prefix 로 저장 → 탐지 성능 대조용
  const key = `traffic-logs/anomaly/${ANOMALY_TYPE}/${nowKST.getTime()}.json`;
  await s3.send(new PutObjectCommand({
    Bucket: LOG_BUCKET,
    Key: key,
    Body: JSON.stringify(runLog, null, 2),
    ContentType: "application/json",
  }));

  console.log(`[anomaly:${ANOMALY_TYPE}] requests=${totalRequests}`);
  return { statusCode: 200, body: JSON.stringify({ anomalyType: ANOMALY_TYPE, totalRequests }) };
};
