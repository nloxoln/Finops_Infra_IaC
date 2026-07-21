#!/bin/bash
set -e  # 에러가 발생하면 스크립트 실행을 즉시 중단하셈~

# ===== 1) Node.js 20 설치 =====
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
  yum install -y nodejs
fi

# psql 클라이언트 (DB 초기 적재용)
yum install -y postgresql15 || yum install -y postgresql

# ===== 2) CodeDeploy 에이전트 설치 =====
yum install -y ruby wget
cd /home/ec2-user
wget -q https://aws-codedeploy-${region}.s3.${region}.amazonaws.com/latest/install
chmod +x ./install
./install auto
systemctl start codedeploy-agent
systemctl enable codedeploy-agent

# ===== 3) app.env 생성 (systemd 서비스가 읽음) =====
cat > /home/ec2-user/app.env << 'ENVEOF'
PGHOST=${db_host}
PGPORT=${db_port}
PGUSER=${db_user}
PGPASSWORD=${db_password}
PGDATABASE=${db_name}
PGSSL=true
NODE_ENV=production
PORT=3000
SESSION_SECRET=${session_secret}
ENVEOF
chown ec2-user:ec2-user /home/ec2-user/app.env
chmod 600 /home/ec2-user/app.env

# --- 추가: CloudWatch Agent 설치 + SSM 파라미터 스토어에서 설정 로드 ---
yum install -y amazon-cloudwatch-agent
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c ssm:${cwagent_param_name}
