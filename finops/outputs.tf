output "cost_api_endpoint" {
  value = "${aws_apigatewayv2_api.cost_api.api_endpoint}/costs"
}