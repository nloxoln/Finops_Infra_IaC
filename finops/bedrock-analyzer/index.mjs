import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const REGION   = process.env.BEDROCK_REGION || "ap-northeast-2";
const MODEL_ID = process.env.BEDROCK_MODEL_ID; // 콘솔에서 확인한 값 (아래 주의사항 참고)
const bedrock  = new BedrockRuntimeClient({ region: REGION });

const resp = (s, b) => ({ statusCode: s, headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

export const handler = async (event = {}) => {
  try {
    const input = typeof event.body === "string" ? JSON.parse(event.body) : (event.body || event);
    const { company, service, severity, rawData, summary, metric } = input;

    const prompt = [
      `너는 AWS FinOps 분석가야. 아래는 비용 이상 탐지 상황이야.`,
      ``,
      `- 계열사: ${company}`,
      `- 서비스: ${service}`,
      `- 심각도: ${severity}`,
      `- 탐지 데이터: ${rawData}`,
      `- 요약: ${summary}`,
      metric ? `- 지표: 평소 $${metric.expected} → $${metric.actual} (${metric.z}σ)` : ``,
      ``,
      `이 상황의 유력한 원인 3가지와, 각 원인을 확인하기 위한 구체적 방법(콘솔 경로/CloudWatch 지표/쿼리 등)을 알려줘.`,
      `Slack에 바로 붙일 수 있게 간결한 한국어로, 원인별 번호를 매겨서 정리해줘.`,
    ].filter(Boolean).join("\n");

    const out = await bedrock.send(new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    }));

    const parsed = JSON.parse(new TextDecoder().decode(out.body));
    const analysis = (parsed.content || []).map(b => b.text).join("\n").trim();

    return resp(200, { analysis });
  } catch (e) {
    console.error("bedrock-analyzer error:", e);
    return resp(500, { error: e.message });
  }
};