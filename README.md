# ✨ SlideCraft AI

Transformez vos documents PDF et Word en présentations PowerPoint (.pptx) professionnelles grâce à ChatGPT (OpenAI), en un seul clic !

## 🚀 Fonctionnalités

- **Lecture de documents** : Extraction automatique du texte depuis les fichiers `.pdf` et `.docx`.
- **Génération IA par ChatGPT (OpenAI)** : Résumé et structuration en diapositives via les modèles OpenAI (`gpt-4o-mini`, `gpt-4o`, etc.).
- **Création de PPTX** : Assemblage et téléchargement automatique du fichier PowerPoint.
- **Personnalisation** : Thèmes de couleur, choix de police, mode sombre, thèmes partageables via URL.
- **Sécurité** : Clé API stockée côté serveur (Render) de façon totalement confidentielle.

## 🛠️ Configuration (Render)

1. Déployez le projet sur Render (Web Service Node.js ou Docker).
2. Dans l'onglet **Environment** de Render, ajoutez la variable :
   - `OPENAI_API_KEY` : Votre clé API OpenAI (commençant par `sk-...`).
   - *(Optionnel)* `OPENAI_MODEL` : `gpt-4o-mini` (par défaut), `gpt-4o`, etc.

## 💻 Technologies utilisées

- **Backend** : Node.js, Express, SDK OpenAI (`openai`).
- **Frontend** : Tailwind CSS, PDF.js, Mammoth.js, PptxGenJS.
