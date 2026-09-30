# Utiliser l'image officielle Node.js 20 (légère et sécurisée)
FROM node:20-alpine

# Créer le répertoire de travail dans le conteneur
WORKDIR /app

# Copier les fichiers package.json
COPY package*.json ./

# Installer les dépendances (Express, Google SDK)
RUN npm install

# Copier le reste des fichiers du projet (server.js, index.html, etc.)
COPY . .

# Exposer le port 3000
EXPOSE 3000

# Commande pour démarrer le serveur
CMD ["node", "server.js"]
