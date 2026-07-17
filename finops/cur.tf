# =====================================================================
# 시간별 CUR — reconciler 보정용 실제 비용 소스 (CE HOURLY opt-in 대체)
# =====================================================================
resource "aws_s3_bucket" "cur" {
  bucket        = "finops-cur-${local.finops_account_id}"
  force_destroy = true
  tags          = { component = "finops-cur" }
}

resource "aws_s3_bucket_lifecycle_configuration" "cur" {
  bucket = aws_s3_bucket.cur.id
  rule {
    id     = "expire-raw-cur"
    status = "Enabled"
    expiration { 
      days = 30 
    }   # 저장 최소화 원칙 유지
  }
}

data "aws_iam_policy_document" "cur_bucket" {
  statement {
    principals { 
      type = "Service"
      identifiers = ["billingreports.amazonaws.com"] 
    }
    actions   = ["s3:GetBucketAcl", "s3:GetBucketPolicy"]
    resources = [aws_s3_bucket.cur.arn]
  }
  statement {
    principals { 
      type = "Service"
      identifiers = ["billingreports.amazonaws.com"] 
    }
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.cur.arn}/*"]
  }
}

resource "aws_s3_bucket_policy" "cur" {
  bucket = aws_s3_bucket.cur.id
  policy = data.aws_iam_policy_document.cur_bucket.json
}

resource "aws_cur_report_definition" "hourly" {
  provider                   = aws.us_east_1     # ★ 기존 프로바이더 재사용
  report_name                = "finops-hourly-cur"
  time_unit                  = "HOURLY"
  format                     = "Parquet"
  compression                = "Parquet"
  additional_schema_elements = ["RESOURCES"]
  s3_bucket                  = aws_s3_bucket.cur.id
  s3_region                  = local.finops_region   # ap-northeast-2
  s3_prefix                  = "cur"
  report_versioning          = "OVERWRITE_REPORT"
  refresh_closed_reports     = true
}