# =====================================================================
# 삭제되지 말라고 폴더 새로팜!!!
# =====================================================================

data "aws_caller_identity" "current" {}

# ---------------------------------------------------------------------
# 1) CUR (Cost and Usage Report) 버킷 — 월간 종합보고서 전용
#    CUR 은 us-east-1 서비스라 정책도 그쪽 기준
# ---------------------------------------------------------------------
resource "aws_s3_bucket" "cur_bucket" {
  bucket        = "${var.log_bucket_prefix}-cur"
  force_destroy = false

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name      = "cost-usage-report"
    component = "billing-cur"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "cur_bucket" {
  bucket = aws_s3_bucket.cur_bucket.id

  rule {
    id     = "expire-old-cur"
    status = "Enabled"

    filter {} # 버킷 전체

    expiration {
      days = 90
    }
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

# ---------------------------------------------------------------------
# 2) 트래픽 PoC ground-truth 로그 버킷
# ---------------------------------------------------------------------
resource "aws_s3_bucket" "traffic_logs" {
  bucket        = "${var.log_bucket_prefix}-traffic-logs"
  force_destroy = false

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name      = "traffic-logs"
    component = "poc-traffic"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "traffic_logs" {
  bucket = aws_s3_bucket.traffic_logs.id

  rule {
    id     = "expire-old-traffic-logs"
    status = "Enabled"

    filter {} # 버킷 전체

    expiration {
      days = 30
    }
  }
}
