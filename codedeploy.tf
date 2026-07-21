# GitHub Actions 가 이 애플리케이션 이름으로 배포를 트리거
resource "aws_codedeploy_app" "app" {
  name             = "oliveyoung-app"
  compute_platform = "Server"
}

resource "aws_codedeploy_deployment_group" "app" {
  app_name              = aws_codedeploy_app.app.name
  deployment_group_name = "oliveyoung-dg"
  service_role_arn      = aws_iam_role.codedeploy_role.arn

  # Name=ec2-app 태그가 붙은 EC2 를 배포 대상으로
  ec2_tag_set {
    ec2_tag_filter {
      key   = "Name"
      type  = "KEY_AND_VALUE"
      value = "ec2-app"
    }
  }

  deployment_style {
    deployment_option = "WITHOUT_TRAFFIC_CONTROL"
    deployment_type   = "IN_PLACE"
  }

  auto_rollback_configuration {
    enabled = true
    events  = ["DEPLOYMENT_FAILURE"]
  }
}
