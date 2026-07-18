# ===== EC2 인스턴스 역할 (CodeDeploy 배포받기 + SSM 접속) =====
resource "aws_iam_role" "ec2_role" {
  name = "ec2-app-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# CodeDeploy 가 배포 번들(S3)을 EC2 로 내려받기 위한 권한
resource "aws_iam_role_policy_attachment" "ec2_s3_read" {
  role       = aws_iam_role.ec2_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess"
}

# SSM Session Manager 로 EC2 접속 (.pem 없이 콘솔에서 접속)
resource "aws_iam_role_policy_attachment" "ec2_ssm" {
  role       = aws_iam_role.ec2_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "cwagent" {
  role       = aws_iam_role.ec2_role.name   # ec2_profile이 참조하는 role 이름으로
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

# EC2 부팅 시 CloudWatch Agent 가 SSM 파라미터에서 읽어갈 설정
resource "aws_ssm_parameter" "cwagent_config" {
  name  = "/cost-poc/cwagent-config"
  type  = "String"
  value = file("${path.module}/cwagent-config.json")

  tags = {
    Name      = "cwagent-config"
    component = "ec2"
  }
}

resource "aws_iam_instance_profile" "ec2_profile" {
  name = "ec2-app-profile"
  role = aws_iam_role.ec2_role.name
}






# ===== CodeDeploy 서비스 역할 =====
resource "aws_iam_role" "codedeploy_role" {
  name = "codedeploy-service-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "codedeploy.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "codedeploy" {
  role       = aws_iam_role.codedeploy_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSCodeDeployRole"
}







# ===== GitHub Actions 배포용 IAM 사용자 =====
# GitHub Secrets(AWS_ACCESS_KEY_ID/SECRET)에 넣을 자격증명.
resource "aws_iam_user" "github_actions" {
  name = "github-actions-deployer"
}

resource "aws_iam_access_key" "github_actions" {
  user = aws_iam_user.github_actions.name
}

resource "aws_iam_user_policy" "github_actions" {
  name = "github-actions-deploy-policy"
  user = aws_iam_user.github_actions.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # 1) CodeDeploy 배포 트리거
      {
        Sid    = "CodeDeploy"
        Effect = "Allow"
        Action = [
          "codedeploy:CreateDeployment",
          "codedeploy:GetDeployment",
          "codedeploy:GetDeploymentConfig",
          "codedeploy:GetApplicationRevision",
          "codedeploy:RegisterApplicationRevision"
        ]
        Resource = "*"
      },
      # 2) 배포 번들 + 정적파일(css/js) S3 업로드
      {
        Sid    = "S3Deploy"
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:ListBucket",
          "s3:DeleteObject"
        ]
        Resource = [
          aws_s3_bucket.codedeploy_bundles.arn,
          "${aws_s3_bucket.codedeploy_bundles.arn}/*",
          aws_s3_bucket.static_assets.arn,
          "${aws_s3_bucket.static_assets.arn}/*"
        ]
      },
      # 3) CloudFront 캐시 무효화
      {
        Sid    = "CloudFrontInvalidation"
        Effect = "Allow"
        Action = [
          "cloudfront:CreateInvalidation",
          "cloudfront:GetInvalidation"
        ]
        Resource = aws_cloudfront_distribution.cdn.arn
      }
    ]
  })
}

#---- 로깅을 위해
resource "aws_iam_role" "rds_monitoring" {
  name = "rds-enhanced-monitoring"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "monitoring.rds.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

