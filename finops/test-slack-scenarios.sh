#!/usr/bin/env bash
# =====================================================================
# 슬랙 알람 시나리오별 테스트 (mock payload)
# ---------------------------------------------------------------------
# estimator 없이 slack-notifier(API Gateway)에 직접 payload를 던져
# 시나리오별 메시지가 슬랙에 예쁘게 오는지 확인한다.
#
# 사용법:
#   1) 아래 SLACK_API 를 실제 엔드포인트로 교체
#   2) bash test-slack-scenarios.sh            # 전체 4종 순차 전송
#      bash test-slack-scenarios.sh cache      # 특정 시나리오만
# =====================================================================

SLACK_API="${SLACK_API:-https://REPLACE_ME.execute-api.ap-northeast-2.amazonaws.com/slack/notify}"

send() {
  local name="$1"; local payload="$2"
  echo "── [$name] 전송 중 ──"
  # 한글 깨짐 방지: payload를 UTF-8 파일로 쓴 뒤 --data-binary 로 바이트 그대로 전송
  local tmp="/tmp/slack_${name}.json"
  printf '%s' "$payload" > "$tmp"
  curl -s -X POST "$SLACK_API" \
    -H "Content-Type: application/json; charset=utf-8" \
    --data-binary @"$tmp"
  echo -e "\n"
  sleep 2
}

# ---- 1) CACHE_MISS_SPAM (CRITICAL) ----
CACHE='{
  "company":"올리브영","severity":"CRITICAL","service":"cloudfront",
  "rawData":"cloudfront 시간당 추정 $0.42 (baseline 평균 $0.05, seasonal, n=5, 7.4σ)",
  "summary":"CloudFront 캐시 미스 급증 — cloudfront 추정비용이 평소 대비 7.4σ 상승",
  "cause":"CloudFront 요청·전송량 급증. 롱테일 이미지 요청이 몰려 캐시 미스율이 올라가 오리진 조회·전송 비용이 함께 증가. 스크래핑/봇 트래픽 가능성.\n\n▶ 권장 조치: ① 캐시 TTL 상향 ② WAF Rate-based rule 차단 ③ 인기상품 캐시 워밍 ④ Referer/UA 필터\n▶ 콘솔 확인: CloudFront 콘솔 → 배포 → Cache statistics(미스율)",
  "actionRequired":true,
  "metric":{"expected":0.05,"actual":0.42,"z":7.4,"sigma":7.4},
  "detectedAt":"2026-07-20T05:10:00Z","hourUTC":"2026-07-20T04"
}'

# ---- 2) EC2_LOAD_SPAM (CRITICAL) ----
EC2='{
  "company":"올리브영","severity":"CRITICAL","service":"ec2",
  "rawData":"ec2 시간당 추정 $0.31 (baseline 평균 $0.05, seasonal, n=5, 9.1σ)",
  "summary":"EC2 부하 급증(초과 크레딧 과금) — ec2 추정비용이 평소 대비 9.1σ 상승",
  "cause":"T3 인스턴스 CPU 크레딧 소진으로 초과 크레딧 과금 발생. 전체 요청량 급증으로 CPU 사용 지속 고부하.\n\n▶ 권장 조치: ① Auto Scaling 수평 확장 ② 상위 인스턴스 타입 전환 ③ T3 Unlimited 검토 ④ 비정상 트래픽 차단\n▶ 콘솔 확인: CloudWatch → EC2 → CPUUtilization / CPUSurplusCreditsCharged",
  "actionRequired":true,
  "metric":{"expected":0.05,"actual":0.31,"z":9.1,"sigma":9.1},
  "detectedAt":"2026-07-20T05:10:00Z","hourUTC":"2026-07-20T04"
}'

# ---- 3) SALE_EVENT (WARNING, 다중 서비스) ----
SALE='{
  "company":"올리브영","severity":"WARNING","service":"multiple",
  "rawData":"cloudfront/elb/ec2 동시 상승 (각 2.3~3.1σ)",
  "summary":"다중 서비스 동시 비용 급증(세일/캠페인성) — 3개 서비스 동시 상승",
  "cause":"여러 서비스(CloudFront·ALB·EC2)가 동시에 상승. 특정 리소스 결함보다 세일/마케팅 캠페인성 전사 트래픽 급증 패턴.\n\n▶ 권장 조치: ① 계획된 이벤트인지 확인(오탐 방지) ② 사전 스케줄 스케일링 ③ 예산 알람 점검 ④ 종료 후 리소스 원복\n▶ 콘솔 확인: FinOps 대시보드 → 비용 추이(전 서비스 동시 상승)",
  "actionRequired":false,
  "metric":{"expected":0.15,"actual":0.48,"z":3.1,"sigma":3.1},
  "detectedAt":"2026-07-20T05:10:00Z","hourUTC":"2026-07-20T04"
}'

# ---- 4) RDS_WRITE_SPAM (WARNING) ----
RDS='{
  "company":"올리브영","severity":"WARNING","service":"rds",
  "rawData":"rds WriteIOPS 12 → 210 (baseline 대비 3.0σ). 비용 기여는 gp2라 작음",
  "summary":"RDS 쓰기 I/O 급증 — 주문/쓰기 트랜잭션 폭주 신호",
  "cause":"RDS WriteIOPS·CPU 급증. 주문/쓰기 트랜잭션 폭주. gp2는 I/O 별도 과금이 없어 비용 기여는 작지만 부하·장애 전조로 중요.\n\n▶ 권장 조치: ① 쓰기 쿼리/배치 점검 ② 슬로우 쿼리 확인 ③ 리드 리플리카 분산 ④ gp3/io1 재검토\n▶ 콘솔 확인: CloudWatch → RDS → WriteIOPS·CPUUtilization / Performance Insights",
  "actionRequired":false,
  "metric":{"expected":0.07,"actual":0.09,"z":3.0,"sigma":3.0},
  "detectedAt":"2026-07-20T05:10:00Z","hourUTC":"2026-07-20T04"
}'

case "${1:-all}" in
  cache) send "CACHE_MISS_SPAM" "$CACHE" ;;
  ec2)   send "EC2_LOAD_SPAM"   "$EC2" ;;
  sale)  send "SALE_EVENT"      "$SALE" ;;
  rds)   send "RDS_WRITE_SPAM"  "$RDS" ;;
  all)
    send "CACHE_MISS_SPAM" "$CACHE"
    send "EC2_LOAD_SPAM"   "$EC2"
    send "SALE_EVENT"      "$SALE"
    send "RDS_WRITE_SPAM"  "$RDS"
    ;;
  *) echo "usage: bash test-slack-scenarios.sh [all|cache|ec2|sale|rds]" ;;
esac
