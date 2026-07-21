# =====================================================================
# 트래픽 주입하기 위한 코드로 실제 코드는 람다 폴더로 가면 nodejs 코드 있음
# =====================================================================


# ---------------------------------------------------------------------
# 1) 람다 소스 zip으로 만들기
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
# 3) Lambda 실행을 위한 역할 생성  
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
# 4) Lambda 함수 생성 - 정상적 트래픽
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
# 5) Lambda 함수 — 비정상적 트래픽
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
# 6) 이벤트 브릿지로 12분 간격, 매일 09~19시 KST(한국 시간)
#    cron(분 시 일 월 요일 년), timezone=Asia/Seoul 로 KST 직접 표현
#    → 매시 0/12/24/36/48분, 9~18시, "매일"(요일 무관)
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

  # 매일 09~18시 KST, 12분 간격. (요일 무관 → 목~월 연속 baseline 확보)
  schedule_expression          = "cron(0/12 9-18 * * ? *)"
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
