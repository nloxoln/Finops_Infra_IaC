
# ---- CUR 데이터 담을 용 ----

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
