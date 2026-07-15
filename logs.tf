# =====================================================================
# 비용 데이터 수집 — CUR 만 유지.
#
# [정리 이력] estimator 가 CloudWatch 네이티브 지표만 사용하므로,
#   비용에 기여하기만 하고 아무도 소비하지 않던 로그 수집을 전부 제거했다:
#   - CloudTrail (관리/데이터 이벤트)        → EC2 스펙변경 감지는 EventBridge 로 대체 가능(트레일 불필요)
#   - S3 서버 액세스 로그 (이미지/정적 버킷)  → 미사용
#   - S3 request metrics (EntireBucket)      → CloudWatch 유료 지표, 미사용
#   - VPC Flow Logs                          → 미사용
#   - ALB 액세스 로그 (alb_ec2.tf)           → 미사용 (블록 제거됨)
#   - CloudFront 액세스 로그 (cloudfront.tf) → 미사용 (블록 제거됨)
# =====================================================================

# ---- CUR (Cost and Usage Report) — 월간 종합보고서 전용 ----
# CUR API 는 us-east-1 에만 존재하므로 해당 provider 사용
resource "aws_cur_report_definition" "main" {
  provider                   = aws.us_east_1
  report_name                = "cost-poc-cur"
  time_unit                  = "HOURLY"
  format                     = "textORcsv"
  compression                = "GZIP"
  additional_schema_elements = ["RESOURCES"] # 리소스 ID 포함 필수
  s3_bucket                  = data.aws_s3_bucket.cur_bucket.id
  s3_region                  = var.aws_region
  s3_prefix                  = "cur"
}
