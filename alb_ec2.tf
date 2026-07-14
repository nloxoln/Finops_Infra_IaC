resource "aws_lb" "app_alb" {
  name               = "app-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb_sg.id]
  subnets            = aws_subnet.public[*].id

  access_logs {
    bucket  = data.aws_s3_bucket.alb_logs.id
    prefix  = "alb"
    enabled = true
  }

  tags = {
    Name      = "app-alb"
    component = "alb"
  }
}

resource "aws_lb_target_group" "app_tg" {
  name     = "app-tg"
  port     = 3000
  protocol = "HTTP"
  vpc_id   = aws_vpc.main.id

  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 2
    interval            = 30
    timeout             = 5
  }

  # EC2 2대 구성에서 세션(로그인) 유지를 위한 고정 세션
  # 같은 클라이언트는 항상 같은 인스턴스로 라우팅됨
  stickiness {
    type            = "lb_cookie"
    cookie_duration = 86400 # 1일
    enabled         = true
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app_alb.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app_tg.arn
  }
}

resource "aws_instance" "web" {
  count                  = length(var.az_list)
  ami                    = var.ami_id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.web-server[count.index].id
  vpc_security_group_ids = [aws_security_group.ec2_sg.id]
  key_name               = var.key_name
  iam_instance_profile   = aws_iam_instance_profile.ec2_profile.name

  # 부팅 시 자동으로: Node 설치 + CodeDeploy 에이전트 설치 + app.env 생성
  user_data = templatefile("${path.module}/user_data.sh.tpl", {
    region             = var.aws_region
    db_host            = aws_db_instance.postgresql.address
    db_port            = 5432
    db_name            = var.db_name
    db_user            = var.db_username
    db_password        = var.db_password
    session_secret     = var.session_secret
    cwagent_param_name = aws_ssm_parameter.cwagent_config.name
  })

  # user_data 변경 시 인스턴스 교체
  user_data_replace_on_change = true

  tags = {
    Name      = "ec2-app"   # CodeDeploy 배포 그룹이 이 태그로 대상을 찾음
    project   = "cost-poc"
    component = "ec2"

  }
}



resource "aws_lb_target_group_attachment" "web" {
  count            = length(var.az_list)
  target_group_arn = aws_lb_target_group.app_tg.arn
  target_id        = aws_instance.web[count.index].id
  port             = 3000
}
