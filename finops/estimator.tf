# =====================================================================
# 시간별 비용 추정 + 일별 보정 파이프라인
#   - estimator  : 매시 :10 KST, CloudWatch 지표 → 고정비+변동비×계수 → DynamoDB(EST#)
#   - reconciler : 매일 05:00 KST, T-2 CE HOURLY 실제비용 → 조인 → EWMA 계수 갱신(COEF#) + 정확도(ACC#)
#   - DynamoDB   : 단일 테이블(pk/sk). EST# 는 TTL 자동폐기, COEF#/ACC# 는 장기보존
# 계정/리전 상수는 cost_api.tf 의 것과 동일 계정을 가정 (429500963680, ap-northeast-2)
# =====================================================================

locals {
  finops_account_id = "429500963680" # 올리브영 계정
  finops_region     = "ap-northeast-2"
}

# slack-notifier(finops_dev 레포에 배포된 API Gateway) 엔드포인트.
# 비워두면 추정기는 슬랙 전송 없이 ALERT 만 DynamoDB 에 기록한다.
variable "slack_api_endpoint" {
  type    = string
  default = ""
}

# ---------------------------------------------------------------------
# DynamoDB — 추정치/보정계수/정확도 단일 테이블
# ---------------------------------------------------------------------
resource "aws_dynamodb_table" "cost_estimates" {
  name         = "finops-cost-estimates"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  # EST# 항목만 ttl 을 채워 자동 폐기(저장 최소화). COEF#/ACC# 는 ttl 미설정 → 영구 보존
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  tags = { component = "finops-estimator" }
}

# =====================================================================
# 1) estimator Lambda
# =====================================================================
data "archive_file" "estimator" {
  type        = "zip"
  source_dir  = "${path.module}/estimator"
  output_path = "${path.module}/estimator.zip"
}

resource "aws_iam_role" "estimator" {
  name = "finops-estimator-role"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "estimator_logs" {
  role       = aws_iam_role.estimator.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "estimator_permissions" {
  name = "finops-estimator-permissions"
  role = aws_iam_role.estimator.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # CloudWatch 지표 읽기 + 리소스 디스커버리(전부 읽기 전용, 리소스 제한 불가한 API 들)
      { Effect = "Allow", Action = [
        "cloudwatch:GetMetricData",
        "elasticloadbalancing:DescribeLoadBalancers",
        "cloudfront:ListDistributions",
        "ec2:DescribeNatGateways",
        "ec2:DescribeInstances",
        "route53:ListHostedZones"
      ], Resource = "*" },
      # DynamoDB 쓰기/계수 읽기
      { Effect = "Allow", Action = ["dynamodb:PutItem", "dynamodb:GetItem"], Resource = aws_dynamodb_table.cost_estimates.arn }
    ]
  })
}

resource "aws_lambda_function" "estimator" {
  function_name    = "finops-estimator"
  role             = aws_iam_role.estimator.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.estimator.output_path
  source_code_hash = data.archive_file.estimator.output_base64sha256
  timeout          = 120
  memory_size      = 256

  environment {
    variables = {
      DDB_TABLE     = aws_dynamodb_table.cost_estimates.name
      REGION        = local.finops_region
      ALB_NAME      = "app-alb"
      RDS_ID        = "cj-olive0"
      CF_ALIAS      = "sharpynloxoln.store"
      R53_DOMAIN    = "sharpynloxoln.store." # Route53 퍼블릭 호스팅 존 이름(끝점 포함)
      EC2_TAG_NAME  = "ec2-app"
      IMAGES_BUCKET = "olive-product"
      STATIC_BUCKET = "front-caching"
      EST_TTL_DAYS  = "90"
      # 이상 탐지 → 슬랙. slack-notifier(API Gateway) URL 을 넣으면 자동 전송.
      # 비워두면 ALERT 만 DynamoDB 에 기록(전송 생략). 예: https://xxxx.execute-api.../slack/notify
      SLACK_API_ENDPOINT = var.slack_api_endpoint
      COMPANY_NAME       = "올리브영"
      Z_WARN             = "2"
      Z_CRIT             = "4"
      # 데이터가 목~월 4일뿐 + 시간대별 계절성만 사용 → baseline 은 7일이면 충분(쿼리 수도 절감).
      # 같은 시간대 표본 최소 3개(목·금·토 정도)면 월요일 테스트 시 탐지 가능.
      MIN_SAMPLES   = "3"
      BASELINE_DAYS = "7"
      BEDROCK_API_ENDPOINT = "${aws_apigatewayv2_stage.bedrock_analyzer.invoke_url}/bedrock/analyze"
    }
  }

  tags = { component = "finops-estimator" }
}

# =====================================================================
# 2) reconciler Lambda
# =====================================================================
data "archive_file" "reconciler" {
  type        = "zip"
  source_dir  = "${path.module}/reconciler"
  output_path = "${path.module}/reconciler.zip"
}

resource "aws_iam_role" "reconciler" {
  name = "finops-reconciler-role"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "reconciler_logs" {
  role       = aws_iam_role.reconciler.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "reconciler_permissions" {
  name = "finops-reconciler-permissions"
  role = aws_iam_role.reconciler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObject", "s3:ListBucket"],
      Resource = ["arn:aws:s3:::oliveyoung-costpoc-cur", "arn:aws:s3:::oliveyoung-costpoc-cur/*"] },
      { Effect = "Allow", Action = ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:Query"],
      Resource = aws_dynamodb_table.cost_estimates.arn }
    ]
  })
}

resource "aws_lambda_function" "reconciler" {
  function_name    = "finops-reconciler"
  role             = aws_iam_role.reconciler.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.reconciler.output_path
  source_code_hash = data.archive_file.reconciler.output_base64sha256
  timeout          = 120
  memory_size      = 256

  environment {
    variables = {
      DDB_TABLE          = aws_dynamodb_table.cost_estimates.name
      REGION             = local.finops_region
      LEARNING_RATE      = "0.3"
      RECONCILE_LAG_DAYS = "2"
      CUR_BUCKET         = "oliveyoung-costpoc-cur"
      CUR_PREFIX         = "cur"
      CUR_REPORT         = "cost-poc-cur"
    }
  }

  tags = { component = "finops-estimator" }
}

# =====================================================================
# 3) EventBridge Scheduler — 공용 실행 역할 + 두 스케줄
# =====================================================================
resource "aws_iam_role" "estimator_scheduler" {
  name = "finops-estimator-scheduler-role"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "scheduler.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}


resource "aws_iam_role_policy" "estimator_scheduler_invoke" {
  name = "finops-estimator-scheduler-invoke"
  role = aws_iam_role.estimator_scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = [aws_lambda_function.estimator.arn, aws_lambda_function.reconciler.arn]
    }]
  })
}

# 매시 :10 KST — 직전 완료된 1시간 구간 추정
resource "aws_scheduler_schedule" "estimator" {
  name = "finops-estimator-schedule"
  flexible_time_window { mode = "OFF" }
  schedule_expression          = "cron(10 * * * ? *)"
  schedule_expression_timezone = "Asia/Seoul"

  target {
    arn      = aws_lambda_function.estimator.arn
    role_arn = aws_iam_role.estimator_scheduler.arn
  }
}

# 매일 05:00 KST — T-2 하루치 보정
resource "aws_scheduler_schedule" "reconciler" {
  name = "finops-reconciler-schedule"
  flexible_time_window { mode = "OFF" }
  schedule_expression          = "cron(0 5 * * ? *)"
  schedule_expression_timezone = "Asia/Seoul"

  target {
    arn      = aws_lambda_function.reconciler.arn
    role_arn = aws_iam_role.estimator_scheduler.arn
  }
}

# ---------------------------------------------------------------------
# 출력값
# ---------------------------------------------------------------------
output "cost_estimates_table" {
  value = aws_dynamodb_table.cost_estimates.name
}

output "estimator_function_name" {
  value = aws_lambda_function.estimator.function_name
}

output "reconciler_function_name" {
  value = aws_lambda_function.reconciler.function_name
}
