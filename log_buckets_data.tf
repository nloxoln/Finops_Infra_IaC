# =====================================================================
# 로그 버킷들은 log-buckets/ 디렉토리의 독립 state 에서 관리된다.
# 여기서는 terraform destroy 시 절대 같이 지워지지 않도록
# 리소스가 아닌 data source 로만 참조한다.
# =====================================================================

data "aws_caller_identity" "current" {}

data "aws_s3_bucket" "access_logs" {
  bucket = "${var.log_bucket_prefix}-s3-access-logs"
}

data "aws_s3_bucket" "alb_logs" {
  bucket = "${var.log_bucket_prefix}-alb-logs"
}

data "aws_s3_bucket" "cf_logs" {
  bucket = "${var.log_bucket_prefix}-cf-logs"
}

data "aws_s3_bucket" "flow_logs" {
  bucket = "${var.log_bucket_prefix}-vpc-flow-logs"
}

data "aws_s3_bucket" "cloudtrail_logs" {
  bucket = "${var.log_bucket_prefix}-cloudtrail-logs"
}

data "aws_s3_bucket" "cur_bucket" {
  bucket = "${var.log_bucket_prefix}-cur"
}

data "aws_s3_bucket" "traffic_logs" {
  bucket = "${var.log_bucket_prefix}-traffic-logs"
}
