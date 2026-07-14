output "access_logs_bucket" {
  value = aws_s3_bucket.access_logs.id
}

output "alb_logs_bucket" {
  value = aws_s3_bucket.alb_logs.id
}

output "cf_logs_bucket" {
  value = aws_s3_bucket.cf_logs.id
}

output "flow_logs_bucket" {
  value = aws_s3_bucket.flow_logs.id
}

output "cloudtrail_logs_bucket" {
  value = aws_s3_bucket.cloudtrail_logs.id
}

output "cur_bucket" {
  value = aws_s3_bucket.cur_bucket.id
}

output "traffic_logs_bucket" {
  value = aws_s3_bucket.traffic_logs.id
}
