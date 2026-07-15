# =====================================================================
# 트래픽 생성 PoC — 정상 트래픽 생성기 + 이상 주입기 (Lambda) + KST 스케줄러
#   - traffic-generator : EventBridge Scheduler(12분 간격, 화~금 09~18 KST)로 상시 구동
#   - anomaly-injector  : ANOMALY_TYPE 환경변수로 4종 전환, 수동/토요일 주입용
#   - ground truth 로그는 전용 버킷(traffic_logs)에 JSON 으로 저장
# =====================================================================

# ---------------------------------------------------------------------
# 0) ground-truth 트래픽 로그 전용 버킷
#    log-buckets/ 의 독립 state 에서 관리 → 여기서는 data source 로만 참조
# ---------------------------------------------------------------------

# 참고: 상품 이미지(products/1.png ~ products/16.png)는 이미 olive-product 버킷에
#       업로드되어 있으므로 별도 업로드 리소스는 두지 않는다.
#       인기상품 = 1~16 (HIT), 롱테일 = 17~9999 (파일 없음 → 404/MISS).

# ---------------------------------------------------------------------
# 1) Lambda 소스 zip 패키징
# ---------------------------------------------------------------------
data "archive_file" "traffic_generator" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/traffic-generator"
  output_path = "${path.module}/lambda/traffic-generator.zip"
}

data "archive_file" "anomaly_injector" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/anomaly-injector"
  output_path = "${path.module}/lambda/anomaly-injector.zip"
}

# ---------------------------------------------------------------------
# 3) Lambda 실행 역할 (로그 버킷 쓰기 + CloudWatch Logs)
# ---------------------------------------------------------------------
resource "aws_iam_role" "traffic_lambda" {
  name = "traffic-poc-lambda-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "traffic_lambda_logs" {
  role       = aws_iam_role.traffic_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "traffic_lambda_s3" {
  name = "traffic-lambda-s3-write"
  role = aws_iam_role.traffic_lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "s3:PutObject"
      Resource = "${data.aws_s3_bucket.traffic_logs.arn}/*"
    }]
  })
}

# ---------------------------------------------------------------------
# 4) Lambda 함수 — 정상 트래픽 생성기
# ---------------------------------------------------------------------
resource "aws_lambda_function" "traffic_generator" {
  function_name    = "traffic-generator"
  role             = aws_iam_role.traffic_lambda.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.traffic_generator.output_path
  source_code_hash = data.archive_file.traffic_generator.output_base64sha256
  timeout          = 700
  memory_size      = 256

  environment {
    variables = {
      ALB_ENDPOINT      = "http://${aws_lb.app_alb.dns_name}"
      CLOUDFRONT_DOMAIN = aws_cloudfront_distribution.cdn.domain_name
      LOG_BUCKET        = data.aws_s3_bucket.traffic_logs.id
    }
  }

  tags = { component = "poc-traffic" }
}

# ---------------------------------------------------------------------
# 5) Lambda 함수 — 이상 주입기
# ---------------------------------------------------------------------
resource "aws_lambda_function" "anomaly_injector" {
  function_name    = "anomaly-injector"
  role             = aws_iam_role.traffic_lambda.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.anomaly_injector.output_path
  source_code_hash = data.archive_file.anomaly_injector.output_base64sha256
  timeout          = 800
  memory_size      = 256

  environment {
    variables = {
      ALB_ENDPOINT      = "http://${aws_lb.app_alb.dns_name}"
      CLOUDFRONT_DOMAIN = aws_cloudfront_distribution.cdn.domain_name
      LOG_BUCKET        = data.aws_s3_bucket.traffic_logs.id
      ANOMALY_TYPE      = "CACHE_MISS_SPAM" # 주입 시 콘솔/CLI 로 변경
      ANOMALY_MULTIPLIER = "100"
    }
  }

  tags = { component = "poc-traffic" }
}

# ---------------------------------------------------------------------
# 6) EventBridge Scheduler — 12분 간격, 화~금 09~18시 KST
#    cron(분 시 일 월 요일 년), timezone=Asia/Seoul 로 KST 직접 표현
#    → 매시 0/12/24/36/48분, 9~18시, 월~금(MON-FRI)
# ---------------------------------------------------------------------
resource "aws_iam_role" "scheduler" {
  name = "traffic-scheduler-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "scheduler_invoke" {
  name = "traffic-scheduler-invoke"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = aws_lambda_function.traffic_generator.arn
    }]
  })
}

resource "aws_scheduler_schedule" "traffic_generator" {
  name = "traffic-generator-schedule"

  flexible_time_window {
    mode = "OFF"
  }

  # 화~금만 작업(MON-FRI 중 화~금은 TUE-FRI). 필요 시 MON-FRI 로 확대 가능.
  schedule_expression          = "cron(0/12 9-18 ? * TUE-FRI *)"
  schedule_expression_timezone = "Asia/Seoul"

  target {
    arn      = aws_lambda_function.traffic_generator.arn
    role_arn = aws_iam_role.scheduler.arn
  }
}

# ---------------------------------------------------------------------
# 7) 출력값
# ---------------------------------------------------------------------
output "traffic_log_bucket" {
  value = data.aws_s3_bucket.traffic_logs.id
}

output "anomaly_injector_function_name" {
  value = aws_lambda_function.anomaly_injector.function_name
}
