resource "aws_cloudtrail" "main" {
  name                          = "cost-poc-trail"
  s3_bucket_name                = data.aws_s3_bucket.cloudtrail_logs.id
  include_global_service_events = true
  is_multi_region_trail         = false

  event_selector {
    read_write_type           = "All"
    include_management_events = true

    # 이미지 버킷 + 프론트 캐시 버킷 두 개 모두 데이터 이벤트 수집
    data_resource {
      type = "AWS::S3::Object"
      values = [
        "${aws_s3_bucket.product_images.arn}/",
        "${aws_s3_bucket.static_assets.arn}/",
      ]
    }
  }

  tags = {
    Name      = "cost-poc-trail"
    component = "logging-cloudtrail"
  }
}

# ---- 이미지 버킷: 서버 액세스 로그 + 요청 메트릭 ----
resource "aws_s3_bucket_logging" "product_images" {
  bucket        = aws_s3_bucket.product_images.id
  target_bucket = data.aws_s3_bucket.access_logs.id
  target_prefix = "s3-images/"
}

resource "aws_s3_bucket_metric" "product_images_requests" {
  bucket = aws_s3_bucket.product_images.id
  name   = "EntireBucket"
}

# ---- 프론트 캐시(static) 버킷: 서버 액세스 로그 + 요청 메트릭 ----
resource "aws_s3_bucket_logging" "static_assets" {
  bucket        = aws_s3_bucket.static_assets.id
  target_bucket = data.aws_s3_bucket.access_logs.id
  target_prefix = "s3-static/"
}

resource "aws_s3_bucket_metric" "static_assets_requests" {
  bucket = aws_s3_bucket.static_assets.id
  name   = "EntireBucket"
}

# ---- VPC Flow Logs (VPC 단위, S3 저장) ----
resource "aws_flow_log" "vpc" {
  vpc_id               = aws_vpc.main.id
  traffic_type         = "ALL"
  log_destination_type = "s3"
  log_destination      = data.aws_s3_bucket.flow_logs.arn

  tags = {
    Name      = "vpc-flow-log"
    component = "logging-vpc-flow"
  }
}

# ---- CUR (Cost and Usage Report) ----
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
