# Use Node.js oficial
FROM node:18-alpine

# Criar diretório de trabalho
WORKDIR /app

# Copiar package.json primeiro (para cache do Docker)
COPY package*.json ./

# Instalar dependências
RUN npm install --only=production

# Copiar código da aplicação
COPY . .

# Expor a porta
EXPOSE 3000

# Comando para iniciar
CMD ["npm", "start"]
