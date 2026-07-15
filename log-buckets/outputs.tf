output "cur_bucket" {
  value = aws_s3_bucket.cur_bucket.id
}

output "traffic_logs_bucket" {
  value = aws_s3_bucket.traffic_logs.id
}
