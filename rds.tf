resource "aws_db_subnet_group" "db_subnet_group" {
  name       = "db-subnet-group"
  subnet_ids = aws_subnet.db[*].id

  tags = { Name = "db-subnet-group" }
}

resource "aws_db_instance" "postgresql" {
  identifier             = "cj-olive0"
  engine                 = "postgres"
  engine_version         = var.db_engine_version
  instance_class         = var.db_instance_class
  allocated_storage      = 20
  db_name                = var.db_name
  username               = var.db_username
  password               = var.db_password
  db_subnet_group_name   = aws_db_subnet_group.db_subnet_group.name
  vpc_security_group_ids = [aws_security_group.rds_sg.id]
  multi_az               = true
  publicly_accessible    = false
  skip_final_snapshot    = true

  monitoring_interval = 60   
  monitoring_role_arn = aws_iam_role.rds_monitoring.arn

  tags = merge(
    { Name = "app-postgresql" },
    { project = "cost-poc", component = "rds-postgresql" }  
  )
}
