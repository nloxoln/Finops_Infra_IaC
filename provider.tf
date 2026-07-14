terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  # 모든 리소스에 project 태그를 자동 부여 (CUR 원인 추적용)
  default_tags {
    tags = {
      project = "cost-poc"
    }
  }
}

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      project = "cost-poc"
    }
  }
}