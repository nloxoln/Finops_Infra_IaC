# =====================================================================
# 로그/비용 데이터 저장용 S3 버킷 모음
#   - access_logs      : S3 서버 액세스 로그 (이미지/프론트 버킷)
#   - alb_logs         : ALB 액세스 로그
#   - cf_logs          : CloudFront 액세스 로그
#   - flow_logs        : VPC Flow Logs
#   - cloudtrail_logs  : CloudTrail 이벤트 로그
#   - cur_bucket       : Cost and Usage Report
# =====================================================================

data "aws_caller_identity" "current" {}

# 리전별 ALB 로그 전송 서비스 계정 (ap-northeast-2 등)
data "aws_elb_service_account" "main" {}

# ---------------------------------------------------------------------
# 1) S3 서버 액세스 로그 버킷
# ---------------------------------------------------------------------
resource "aws_s3_bucket" "access_logs" {
  bucket        = "${var.log_bucket_prefix}-s3-access-logs"
  force_destroy = true

  tags = {
    Name      = "s3-access-logs"
    component = "logging-s3-access"
  }
}

# S3 로그 전송 그룹이 쓸 수 있도록 ACL 활성화 + 권한 부여
resource "aws_s3_bucket_ownership_controls" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

resource "aws_s3_bucket_acl" "access_logs" {
  depends_on = [aws_s3_bucket_ownership_controls.access_logs]
  bucket     = aws_s3_bucket.access_logs.id
  acl        = "log-delivery-write"
}

# ---------------------------------------------------------------------
# 2) ALB 액세스 로그 버킷
# ---------------------------------------------------------------------
resource "aws_s3_bucket" "alb_logs" {
  bucket        = "${var.log_bucket_prefix}-alb-logs"
  force_destroy = true

  tags = {
    Name      = "alb-logs"
    component = "logging-alb"
  }
}

# ALB 가 access_logs { prefix = "alb" } 경로에 로그를 쓸 수 있도록 권한 부여
resource "aws_s3_bucket_policy" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowALBLogDelivery"
        Effect    = "Allow"
        Principal = { AWS = data.aws_elb_service_account.main.arn }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.alb_logs.arn}/alb/AWSLogs/${data.aws_caller_identity.current.account_id}/*"
      }
    ]
  })
}

# ---------------------------------------------------------------------
# 3) CloudFront 액세스 로그 버킷
#    (CloudFront 표준 로깅은 ACL 기반 → ownership/ACL 설정 필요)
# ---------------------------------------------------------------------
resource "aws_s3_bucket" "cf_logs" {
  bucket        = "${var.log_bucket_prefix}-cf-logs"
  force_destroy = true

  tags = {
    Name      = "cloudfront-logs"
    component = "logging-cloudfront"
  }
}

resource "aws_s3_bucket_ownership_controls" "cf_logs" {
  bucket = aws_s3_bucket.cf_logs.id
  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

resource "aws_s3_bucket_acl" "cf_logs" {
  depends_on = [aws_s3_bucket_ownership_controls.cf_logs]
  bucket     = aws_s3_bucket.cf_logs.id
  acl        = "log-delivery-write"
}

# ---------------------------------------------------------------------
# 4) VPC Flow Logs 버킷
# ---------------------------------------------------------------------
resource "aws_s3_bucket" "flow_logs" {
  bucket        = "${var.log_bucket_prefix}-vpc-flow-logs"
  force_destroy = true

  tags = {
    Name      = "vpc-flow-logs"
    component = "logging-vpc-flow"
  }
}

# ---------------------------------------------------------------------
# 5) CloudTrail 로그 버킷
# ---------------------------------------------------------------------
resource "aws_s3_bucket" "cloudtrail_logs" {
  bucket        = "${var.log_bucket_prefix}-cloudtrail-logs"
  force_destroy = true

  tags = {
    Name      = "cloudtrail-logs"
    component = "logging-cloudtrail"
  }
}

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
        Condition = {
          StringEquals = {
            "s3:x-amz-acl" = "bucket-owner-full-control"
          }
        }
      }
    ]
  })
}

# ---------------------------------------------------------------------
# 6) CUR (Cost and Usage Report) 버킷
#    CUR 은 us-east-1 서비스라 정책도 그쪽 기준
# ---------------------------------------------------------------------
resource "aws_s3_bucket" "cur_bucket" {
  bucket        = "${var.log_bucket_prefix}-cur"
  force_destroy = true

  tags = {
    Name      = "cost-usage-report"
    component = "billing-cur"
  }
}

resource "aws_s3_bucket_policy" "cur_bucket" {
  bucket = aws_s3_bucket.cur_bucket.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCURAclCheck"
        Effect    = "Allow"
        Principal = { Service = "billingreports.amazonaws.com" }
        Action    = ["s3:GetBucketAcl", "s3:GetBucketPolicy"]
        Resource  = aws_s3_bucket.cur_bucket.arn
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = data.aws_caller_identity.current.account_id
          }
        }
      },
      {
        Sid       = "AllowCURWrite"
        Effect    = "Allow"
        Principal = { Service = "billingreports.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.cur_bucket.arn}/*"
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = data.aws_caller_identity.current.account_id
          }
        }
      }
    ]
  })
}
