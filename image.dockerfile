# Base image
FROM node:20-slim

# Install ffmpeg
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Workdir
WORKDIR /app

# Install deps
COPY package*.json ./
RUN npm install

# Copy rest
COPY . .

# Expose port
EXPOSE 3000

# Start
CMD ["npm", "start"]
