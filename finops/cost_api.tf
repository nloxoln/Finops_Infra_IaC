# ---- 이 파일 전용 caller identity (root에 없어서 여기서 선언) ----
data "aws_caller_identity" "cost_api" {}

# ---- 캐시 저장용 S3 버킷 ----
resource "aws_s3_bucket" "cost_cache" {
  bucket        = "finops-cost-cache-${data.aws_caller_identity.cost_api.account_id}"
  force_destroy = true

  tags = { component = "finops-cost-cache" }
}

# ---- API Gateway (HTTP API) 본체 — 이게 빠져있었음 ----
resource "aws_apigatewayv2_api" "cost_api" {
  name          = "finops-cost-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "OPTIONS"]
    allow_headers = ["Content-Type"]
  }
}

resource "aws_apigatewayv2_stage" "cost_api" {
  api_id      = aws_apigatewayv2_api.cost_api.id
  name        = "finops-dev"   # 지금 .env의 URL 경로(/finops-dev/cost)와 맞춤
  auto_deploy = true
}

# ---- 수집기 (스케줄러가 실행, CE 호출 O) ----
data "archive_file" "cost_collector" {
  type        = "zip"
  source_dir  = "${path.module}/cost-collector"
  output_path = "${path.module}/cost-collector.zip"
}

resource "aws_iam_role" "cost_collector" {
  name = "cost-collector-lambda-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "cost_collector_logs" {
  role       = aws_iam_role.cost_collector.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "cost_collector_permissions" {
  name = "cost-collector-permissions"
  role = aws_iam_role.cost_collector.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ce:GetCostAndUsage"], Resource = "*" },
      { Effect = "Allow", Action = ["s3:PutObject"], Resource = "${aws_s3_bucket.cost_cache.arn}/*" }
    ]
  })
}

resource "aws_lambda_function" "cost_collector" {
  function_name    = "finops-cost-collector"
  role             = aws_iam_role.cost_collector.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.cost_collector.output_path
  source_code_hash = data.archive_file.cost_collector.output_base64sha256
  timeout          = 60
  memory_size      = 256

  environment {
    variables = {
      CACHE_BUCKET    = aws_s3_bucket.cost_cache.id
      KRW_TO_USD_RATE = "1350"
      ACCOUNT_ID      = "429500963680"   # 올리브영 계정 하나만
    }
  }
}

# ---- 하루 2번(00시, 12시) 스케줄 ----
resource "aws_iam_role" "cost_scheduler" {
  name = "cost-collector-scheduler-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "scheduler.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "cost_scheduler_invoke" {
  name = "cost-collector-scheduler-invoke"
  role = aws_iam_role.cost_scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "lambda:InvokeFunction", Resource = aws_lambda_function.cost_collector.arn }]
  })
}

resource "aws_scheduler_schedule" "cost_collector" {
  name = "cost-collector-schedule"
  flexible_time_window { mode = "OFF" }
  schedule_expression          = "cron(0 0,12 * * ? *)"
  schedule_expression_timezone = "Asia/Seoul"

  target {
    arn      = aws_lambda_function.cost_collector.arn
    role_arn = aws_iam_role.cost_scheduler.arn
  }
}

# ---- 조회기 (API Gateway가 호출, CE 호출 없음) ----
data "archive_file" "cost_reader" {
  type        = "zip"
  source_dir  = "${path.module}/cost-reader"
  output_path = "${path.module}/cost-reader.zip"
}

resource "aws_iam_role" "cost_reader" {
  name = "cost-reader-lambda-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "cost_reader_logs" {
  role       = aws_iam_role.cost_reader.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "cost_reader_s3" {
  name = "cost-reader-s3-read"
  role = aws_iam_role.cost_reader.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["s3:GetObject"], Resource = "${aws_s3_bucket.cost_cache.arn}/*" }]
  })
}

resource "aws_lambda_function" "cost_reader" {
  function_name    = "finops-cost-reader"
  role             = aws_iam_role.cost_reader.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.cost_reader.output_path
  source_code_hash = data.archive_file.cost_reader.output_base64sha256
  timeout          = 10
  memory_size      = 128

  environment {
    variables = { CACHE_BUCKET = aws_s3_bucket.cost_cache.id }
  }
}

resource "aws_apigatewayv2_integration" "cost_reader" {
  api_id                 = aws_apigatewayv2_api.cost_api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.cost_reader.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "cost_reader" {
  api_id    = aws_apigatewayv2_api.cost_api.id
  route_key = "GET /cost"
  target    = "integrations/${aws_apigatewayv2_integration.cost_reader.id}"
}

resource "aws_lambda_permission" "cost_reader_invoke" {
  statement_id  = "AllowAPIGatewayInvokeReader"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.cost_reader.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.cost_api.execution_arn}/*/*"
}