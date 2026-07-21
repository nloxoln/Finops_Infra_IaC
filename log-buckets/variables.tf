variable "aws_region" {
  type    = string
  default = "ap-northeast-2"
}

# 로그/비용 데이터 버킷에 붙일거
variable "log_bucket_prefix" {
  type    = string
  default = "oliveyoung-costpoc"
}
