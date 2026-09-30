# ✨ SlideCraft AI

Transformez vos documents PDF et Word en présentations PowerPoint (.pptx) structurées grâce à l'Intelligence Artificielle, en un seul clic ! 

Cette application fonctionne **100% dans votre navigateur**, sans aucune installation requise sur votre ordinateur et sans serveur backend (base de données). Vos données sont traitées directement chez vous.

## 🚀 Fonctionnalités

- **Lecture de documents** : Extraction automatique du texte depuis les fichiers `.pdf` et `.docx`.
- **Génération par l'IA** : Résumé et structuration en diapositives via l'API gratuite de Google Gemini.
- **Création de PPTX** : Assemblage et téléchargement du fichier PowerPoint généré instantanément.
- **Sécurité et Vie Privée** : 100% Client-Side. Vos documents ne sont envoyés sur aucun serveur (hormis vers l'API de Google pour l'IA).

## 🛠️ Comment l'utiliser ?

1. **Ouvrir l'application** : Accédez au lien web (si hébergé sur GitHub Pages) ou double-cliquez simplement sur le fichier `index.html` pour l'ouvrir dans Chrome, Edge ou Firefox.
2. **Clé API** : Obtenez une clé API Gemini gratuite sur [Google AI Studio](https://aistudio.google.com/app/apikey).
3. **Génération** : 
   - Collez votre clé dans le champ prévu.
   - Sélectionnez un document (PDF ou Word).
   - Cliquez sur "Générer la présentation".
4. Le fichier `.pptx` se télécharge automatiquement en quelques secondes !

## 💻 Technologies utilisées

Cette application est constituée d'un seul fichier HTML utilisant les librairies suivantes via CDN :
- **[Tailwind CSS](https://tailwindcss.com/)** : Pour une interface propre et moderne.
- **[PDF.js](https://mozilla.github.io/pdf.js/)** (Mozilla) : Pour l'extraction du texte des PDF.
- **[Mammoth.js](https://github.com/mwilliamson/mammoth.js)** : Pour l'extraction du texte des fichiers Word.
- **[PptxGenJS](https://gitbrent.github.io/PptxGenJS/)** : Pour la construction du fichier PowerPoint en JavaScript.
- **[API Google Gemini](https://ai.google.dev/)** : Le moteur d'intelligence artificielle.
