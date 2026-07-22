# =====================================================================
# CloudTrail 비용 유발 이벤트 → slack-notifier 알림
#   - EventBridge 규칙이 '비용을 늘릴 수 있는' 관리 이벤트(RunInstances,
#     ModifyInstanceAttribute 등)를 매칭 → Lambda 트리거
#   - Lambda 가 심각도(WARNING/CRITICAL)를 판정해 기존 slack-notifier로 POST
#
#   var.slack_api_endpoint 는 estimator.tf 에서 이미 선언됨 → 여기선 재사용만.
#   (같은 finops 모듈이므로 중복 선언 금지)
#
#   ※ 전제: 이 리전에 CloudTrail 관리 이벤트(Write) trail 이 켜져 있어야
#     EventBridge 로 이벤트가 전달됨.
# =====================================================================

variable "cost_event_min_severity" {
  type        = string
  default     = "WARNING"
  description = "이 심각도 이상만 슬랙 전송 (WARNING | CRITICAL)"
}

locals {
  # EventBridge 로 감지할 '비용 유발' 이벤트 목록
  cost_event_names = [
    "RunInstances", "StartInstances", "ModifyInstanceAttribute",
    "CreateNatGateway", "AllocateAddress", "CreateFleet", "RequestSpotFleet",
    "PurchaseReservedInstancesOffering", "CreateVolume",
    "CreateDBInstance", "ModifyDBInstance", "CreateDBCluster", "ModifyDBCluster",
    "CreateDBInstanceReadReplica", "PurchaseReservedDBInstancesOffering",
    "CreateTable", "UpdateTable",
    "CreateCacheCluster", "ModifyCacheCluster", "CreateReplicationGroup",
    "ResizeCluster", "ModifyCluster",
    "CreateEndpoint", "UpdateEndpoint", "UpdateEndpointWeightsAndCapacities",
    "CreateNotebookInstance",
    "UpdateAutoScalingGroup", "SetDesiredCapacity", "RegisterScalableTarget",
    "UpdateShardCount", "CreateStream",
    "PutProvisionedConcurrencyConfig",
    "CreateDomain", "UpdateDomainConfig",
    "CreateNodegroup", "RunJobFlow", "CreateCluster",
    "CreateProvisionedModelThroughput",
  ]
}

# ---------------------------------------------------------------------
# Lambda 패키징
# ---------------------------------------------------------------------
data "archive_file" "cost_event_alerter" {
  type        = "zip"
  source_dir  = "${path.module}/cost-event-alerter"
  output_path = "${path.module}/cost-event-alerter.zip"
}

# ---------------------------------------------------------------------
# IAM (로그만 필요 - AWS API 호출 없음)
# ---------------------------------------------------------------------
resource "aws_iam_role" "cost_event_alerter" {
  name = "finops-cost-event-alerter-role"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "cost_event_alerter_logs" {
  role       = aws_iam_role.cost_event_alerter.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# ---------------------------------------------------------------------
# Lambda
# ---------------------------------------------------------------------
resource "aws_lambda_function" "cost_event_alerter" {
  function_name    = "finops-cost-event-alerter"
  role             = aws_iam_role.cost_event_alerter.arn
  runtime          = "python3.12"
  handler          = "lambda_function.lambda_handler"
  filename         = data.archive_file.cost_event_alerter.output_path
  source_code_hash = data.archive_file.cost_event_alerter.output_base64sha256
  timeout          = 15
  memory_size      = 128

  environment {
    variables = {
      SLACK_API_ENDPOINT = var.slack_api_endpoint
      COMPANY_NAME       = "올리브영"
      MIN_SEVERITY       = var.cost_event_min_severity
    }
  }

  tags = { component = "finops-cost-event-alerter" }
}

# ---------------------------------------------------------------------
# EventBridge 규칙 (CloudTrail 관리 이벤트 매칭)
# ---------------------------------------------------------------------
resource "aws_cloudwatch_event_rule" "cost_event" {
  name        = "finops-cost-event-alerter"
  description = "비용을 추가로 발생시킬 수 있는 API 호출 감지"

  event_pattern = jsonencode({
    "detail-type" = ["AWS API Call via CloudTrail"]
    detail = {
      eventName = local.cost_event_names
    }
  })
}

resource "aws_cloudwatch_event_target" "cost_event" {
  rule      = aws_cloudwatch_event_rule.cost_event.name
  target_id = "finops-cost-event-alerter"
  arn       = aws_lambda_function.cost_event_alerter.arn
}

resource "aws_lambda_permission" "cost_event" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.cost_event_alerter.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.cost_event.arn
}

# ---------------------------------------------------------------------
# 출력
# ---------------------------------------------------------------------
output "cost_event_alerter_function_name" {
  value = aws_lambda_function.cost_event_alerter.function_name
}
