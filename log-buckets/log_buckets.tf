# =====================================================================
# 로그/비용 데이터 저장용 S3 버킷 (독립 state)
#   메인 인프라(terraform destroy) 와 분리되어 있어 실수로 같이 지워지지 않는다.
#
# [정리] estimator 가 CloudWatch 네이티브 지표만 사용하므로,
#        아무도 소비하지 않던 로그 버킷들을 제거했다:
#          access_logs / alb_logs / cf_logs / flow_logs / cloudtrail_logs  → 삭제
#        현재 유지하는 버킷은 둘뿐이며, 둘 다 lifecycle 만료로 저장량을 제한한다:
#          - cur_bucket   : 월간 종합보고서용 CUR (90일 후 만료)
#          - traffic_logs : 트래픽 PoC ground-truth (30일 후 만료)
#
#   ⚠️ 삭제된 버킷들은 이전에 prevent_destroy = true 였다. 이 블록들을 제거한 뒤
#      `terraform apply` 시 prevent_destroy 오류가 나면, 삭제 대상 버킷에
#      임시로 `lifecycle { prevent_destroy = false }` 를 넣고 apply → 다시 제거하면 된다.
#      (비어있는 S3 버킷 자체는 비용이 0 이므로, 급하지 않으면 방치해도 무방)
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
