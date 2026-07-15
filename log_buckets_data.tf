# =====================================================================
# 로그 버킷들은 log-buckets/ 디렉토리의 독립 state 에서 관리된다.
# 여기서는 terraform destroy 시 절대 같이 지워지지 않도록
# 리소스가 아닌 data source 로만 참조한다.
#
# [정리] 미사용 로그 수집(access/alb/cf/flow/cloudtrail)을 제거하면서
#        해당 버킷 참조도 삭제. 현재는 CUR + traffic_logs 만 유지한다.
# =====================================================================

data "aws_caller_identity" "current" {}

data "aws_s3_bucket" "cur_bucket" {
  bucket = "${var.log_bucket_prefix}-cur"
}

data "aws_s3_bucket" "traffic_logs" {
  bucket = "${var.log_bucket_prefix}-traffic-logs"
}
