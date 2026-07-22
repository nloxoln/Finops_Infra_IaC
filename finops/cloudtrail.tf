# =====================================================================
# CloudTrail 트레일 — 관리 이벤트(Write)를 기록해 EventBridge 로 흘려보낸다.
#   cost-event-alerter 가 실제 콘솔/CLI 이벤트를 받으려면 이 trail 이 필수.
#   비용 최소화를 위해 Write 관리 이벤트만 기록하고 데이터 이벤트는 끔.
# =====================================================================

data "aws_caller_identity" "current" {}

# ---- 로그 저장용 S3 버킷 ----
resource "aws_s3_bucket" "cloudtrail_logs" {
  bucket        = "finops-cloudtrail-${data.aws_caller_identity.current.account_id}"
  force_destroy = true
  tags          = { component = "finops-cloudtrail" }
}

# 버킷 공개 차단
resource "aws_s3_bucket_public_access_block" "cloudtrail_logs" {
  bucket                  = aws_s3_bucket.cloudtrail_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# CloudTrail 이 이 버킷에 쓰도록 허용하는 버킷 정책
resource "aws_s3_bucket_policy" "cloudtrail_logs" {
  bucket = aws_s3_bucket.cloudtrail_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AWSCloudTrailAclCheck"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:GetBucketAcl"
        Resource  = aws_s3_bucket.cloudtrail_logs.arn
      },
      {
        Sid       = "AWSCloudTrailWrite"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.cloudtrail_logs.arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"
        Condition = { StringEquals = { "s3:x-amz-acl" = "bucket-owner-full-control" } }
      }
    ]
  })
}

# ---- 트레일 ----
resource "aws_cloudtrail" "finops" {
  name                          = "finops-management-trail"
  s3_bucket_name                = aws_s3_bucket.cloudtrail_logs.id
  include_global_service_events = true
  is_multi_region_trail         = false # 서울 단일 리전이면 false 로 충분(비용 절감)
  enable_logging                = true

  # 관리 이벤트 중 Write 만 기록 (비용 최소화)
  event_selector {
    read_write_type           = "WriteOnly"
    include_management_events = true
  }

  depends_on = [aws_s3_bucket_policy.cloudtrail_logs]
  tags       = { component = "finops-cloudtrail" }
}

output "cloudtrail_name" {
  value = aws_cloudtrail.finops.name
}
