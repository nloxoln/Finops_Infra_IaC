resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name      = "main-vpc"
    component = "vpc"
  }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "main-igw"
  }
}

# ---- 서브넷 ----
resource "aws_subnet" "public" {
  count                   = length(var.az_list)
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = var.az_list[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "public-subnet-${count.index}"
  }
}

resource "aws_subnet" "web-server" {
  count             = length(var.az_list)
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.web_subnet_cidrs[count.index]
  availability_zone = var.az_list[count.index]
  map_public_ip_on_launch = false

  tags = {
    Name = "web-subnet-${count.index}"
  }
}

resource "aws_subnet" "db" {
  count             = length(var.az_list)
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.db_subnet_cidrs[count.index]
  availability_zone = var.az_list[count.index]
  map_public_ip_on_launch = false

  tags = {
    Name = "db-subnet-${count.index}"
  }
}

resource "aws_eip" "nat" {
  count  = length(var.az_list)
  domain = "vpc"

  tags = {
    Name = "nat-eip-${count.index}"
  }
}

resource "aws_nat_gateway" "nat" {
  count         = length(var.az_list)
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = {
    Name = "nat-gw-${count.index}"
  }

  depends_on = [aws_internet_gateway.igw]
}


# ---- Public Route Table ----
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }

  tags = {
    Name = "public-rt"
  }
}

resource "aws_route_table_association" "public" {
  count          = length(var.az_list)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}


# ---- Private Route Table : Web ----
resource "aws_route_table" "web" {
  count  = length(var.az_list)
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.nat[count.index].id
  }

  tags = {
    Name = "private-web-rt-${count.index}"
  }
}

resource "aws_route_table_association" "web" {
  count          = length(var.az_list)
  subnet_id      = aws_subnet.web-server[count.index].id
  route_table_id = aws_route_table.web[count.index].id
}


# ---- Private Route Table : db ----
resource "aws_route_table" "db" {
  count  = length(var.az_list)
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "private-rt-${count.index}"
  }
}

resource "aws_route_table_association" "db" {
  count          = length(var.az_list)
  subnet_id      = aws_subnet.db[count.index].id
  route_table_id = aws_route_table.db[count.index].id
}
