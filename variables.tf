variable "aws_region" {
  type    = string
  default = "ap-northeast-2"
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16" 
}

variable "az_list" {
  type    = list(string)
  default = ["ap-northeast-2a", "ap-northeast-2c"] 
}

variable "public_subnet_cidrs" {
  type    = list(string)
  default = ["10.0.0.0/24", "10.0.1.0/24"]
}

variable "web_subnet_cidrs" {
  type    = list(string)
  default = ["10.0.20.0/24", "10.0.21.0/24"]
}

variable "db_subnet_cidrs" {
  type    = list(string)
  default = ["10.0.40.0/24", "10.0.41.0/24"] 
}

variable "instance_type" {
  type    = string
  default = "t3.small"
}

variable "ami_id" {
  type    = string
  default = "ami-08c64967154312fa5" 
}

variable "key_name" {
  type    = string
  default = "web-connect"
}

variable "db_engine_version" {
  type    = string
  default = "18.4"
}

variable "db_instance_class" {
  type    = string
  default = "db.t3.small"
}

variable "db_name" {
  type    = string
  default = "oliveyoung"
}

variable "db_username" {
  type      = string
  default   = "postgres"
  sensitive = true
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "session_secret" {
  type      = string
  sensitive = true
  default   = "change-me-to-a-random-string"
}

variable "codedeploy_bucket_name" {
  type    = string
  default = "oliveyoung-codedeploy-bundles"
}

variable "domain_name" {
  type    = string
  default = "sharpynloxoln.store"
}

variable "s3_static_bucket_name" {
  type    = string
  default = "front-caching" 
}

variable "s3_images_bucket_name" {
  type    = string
  default = "olive-product"
}

# 로그/비용 데이터 버킷들의 공통 접두어 (전역 유일해야 하므로 계정 고유값으로 변경 권장)
variable "log_bucket_prefix" {
  type    = string
  default = "oliveyoung-costpoc"
}