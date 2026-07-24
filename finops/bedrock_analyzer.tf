data "archive_file" "bedrock_analyzer" {
  type        = "zip"
  source_dir  = "${path.module}/../bedrock-analyzer"
  output_path = "${path.module}/bedrock-analyzer.zip"
}

resource "aws_iam_role" "bedrock_analyzer" {
  name = "finops-bedrock-analyzer-role"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "bedrock_analyzer_logs" {
  role       = aws_iam_role.bedrock_analyzer.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "bedrock_analyzer_invoke" {
  name = "finops-bedrock-analyzer-invoke"
  role = aws_iam_role.bedrock_analyzer.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["bedrock:InvokeModel"], Resource = "*" }]
  })
}

resource "aws_lambda_function" "bedrock_analyzer" {
  function_name    = "finops-bedrock-analyzer"
  role             = aws_iam_role.bedrock_analyzer.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.bedrock_analyzer.output_path
  source_code_hash = data.archive_file.bedrock_analyzer.output_base64sha256
  timeout          = 60
  memory_size      = 256

  environment {
    variables = {
      BEDROCK_REGION   = "ap-northeast-2"
      BEDROCK_MODEL_ID = "apac.anthropic.claude-sonnet-4-5-20250929-v1:0"   # 2단계에서 복사한 값
    }
  }

  tags = { component = "finops-bedrock-analyzer" }
}

resource "aws_apigatewayv2_api" "bedrock_analyzer" {
  name          = "finops-bedrock-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "bedrock_analyzer" {
  api_id                 = aws_apigatewayv2_api.bedrock_analyzer.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.bedrock_analyzer.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "bedrock_analyzer" {
  api_id    = aws_apigatewayv2_api.bedrock_analyzer.id
  route_key = "POST /bedrock/analyze"
  target    = "integrations/${aws_apigatewayv2_integration.bedrock_analyzer.id}"
}

resource "aws_apigatewayv2_stage" "bedrock_analyzer" {
  api_id      = aws_apigatewayv2_api.bedrock_analyzer.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "bedrock_analyzer_apigw" {
  statement_id  = "AllowAPIGWInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.bedrock_analyzer.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.bedrock_analyzer.execution_arn}/*/*"
}

output "bedrock_api_endpoint" {
  value = "${aws_apigatewayv2_stage.bedrock_analyzer.invoke_url}/bedrock/analyze"
}