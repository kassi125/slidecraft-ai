# ✨ SlideCraft AI

Transformez vos documents PDF et Word en présentations PowerPoint (.pptx) professionnelles grâce à **Groq (Llama 3.3 70B)**, en un seul clic !

## 🚀 Fonctionnalités

- **Lecture de documents** : Extraction automatique du texte depuis les fichiers `.pdf` et `.docx`.
- **Génération IA ultra-rapide par Groq (100% Gratuit)** : Résumé et structuration en diapositives via le modèle surpuissant `llama-3.3-70b-versatile` de Meta.
- **Création de PPTX** : Assemblage et téléchargement automatique du fichier PowerPoint.
- **10 Thèmes Prédéfinis** : Corporate, Tech, Académique, Luxe, Éco, Pitch Deck, etc.
- **Sauvegarde d'URL** : Thèmes personnalisés partageables instantanément par lien.
- **Sécurité** : Clé API stockée côté serveur (Render) de façon totalement confidentielle.

## 🛠️ Configuration (Render)

1. Obtenez votre clé API Groq gratuite sur **[console.groq.com/keys](https://console.groq.com/keys)** (sans carte bancaire).
2. Déployez le projet sur Render (Web Service).
3. Dans l'onglet **Environment** de Render, ajoutez la variable :
   - `GROQ_API_KEY` : Votre clé API Groq (commençant par `gsk_...`).

## 💻 Technologies utilisées

- **Backend** : Node.js, Express, Groq API (via SDK OpenAI).
- **Frontend** : Tailwind CSS, PDF.js, Mammoth.js, PptxGenJS.
