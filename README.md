# AWS FinOps 자동 비용 추정 · 이상탐지 파이프라인

AWS 실제 청구서(CUR)는 1~2일 지연되어 도착합니다. 이 프로젝트는 CloudWatch 지표로
**시간 단위 비용을 실시간 추정**하고, 다음날 실제 청구서로 **오차를 스스로 학습·보정**하며,
비용이 급증하면 **Slack으로 즉시 알림**을 보내는 서버리스 시스템입니다. (Terraform 기반)

## 핵심 기능

- ⏱️ **시간별 비용 추정** — CloudWatch 지표(EC2, RDS, ALB, CloudFront, NAT, Route53) 기반
- 🚨 **이상탐지** — 같은 시간대 과거 데이터로 baseline을 만들어 z-score로 급증 감지
- 🔁 **자기보정** — 다음날 실제 청구서(CUR)와 대조해 보정계수를 EWMA로 자동 학습 → 갈수록 정확해짐
- 🤖 **AI 원인분석** — Bedrock(Claude)이 이상탐지 원인을 자연어로 설명해 Slack에 전송
- ⚡ **실시간 이벤트 알림** — CloudTrail로 비용 유발 API 호출(인스턴스 생성 등) 즉시 감지
- 📊 **대시보드 API** — 수집기/조회기를 분리해 조회는 항상 즉시 응답

## 구성요소

| 컴포넌트 | 트리거 | 역할 |
|---|---|---|
| estimator | 매시 :10 | 비용 추정 + 이상탐지 |
| reconciler | 매일 05:00 | 실제값 대조 + 보정계수 학습 |
| cost-collector | 하루 2회 | 대시보드용 데이터 캐싱 |
| cost-reader | API 호출 시 | 캐시 즉시 응답 |
| cost-event-alerter | CloudTrail 이벤트 | 실시간 Slack 알림 |
| bedrock-analyzer | estimator 호출 시 | AI 원인분석 |

## 기술 스택

Terraform · AWS Lambda(Node.js/Python) · DynamoDB · S3 · API Gateway · EventBridge Scheduler ·
CloudTrail · Amazon Bedrock(Claude) · Cost Explorer / CUR

## 배포

```bash
cd finops
terraform init
terraform apply -var="slack_api_endpoint=https://<slack-notifier-endpoint>"
```

## 테스트

```bash
SLACK_API="https://<엔드포인트>" bash test-slack-scenarios.sh
```
