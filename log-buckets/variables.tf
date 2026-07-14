variable "aws_region" {
  type    = string
  default = "ap-northeast-2"
}

# 로그/비용 데이터 버킷들의 공통 접두어 (전역 유일해야 하므로 계정 고유값으로 변경 권장)
variable "log_bucket_prefix" {
  type    = string
  default = "oliveyoung-costpoc"
}
