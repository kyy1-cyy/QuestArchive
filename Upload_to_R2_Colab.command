#!/bin/zsh
set -euo pipefail

FILE_PATH="$(osascript -e 'POSIX path of (choose file with prompt "Select a .zip to upload via Colab" of type {"zip"})')"

echo "Selected:"
echo "$FILE_PATH"

if [[ "${FILE_PATH:l}" != *.zip ]]; then
  echo "Error: selected file is not a .zip"
  exit 1
fi

printf "%s" "$FILE_PATH" | pbcopy
echo ""
echo "Copied local path to clipboard."
echo ""
echo "Colab cannot magically upload a local file faster than your own upload speed."
echo "But once the file is in Colab, the upload from Colab -> R2 can be very fast."
echo ""
echo "Opening Colab uploader notebook..."
open "https://colab.research.google.com/github/kyy1-cyy/QuestArchive/blob/main/Colab_R2_Uploader.ipynb"

echo ""
echo "In Colab:"
echo "1) Run the setup cell"
echo "2) Use the file picker to upload your .zip from your computer"
echo "3) Enter your R2 endpoint + keys when prompted"
echo "4) Watch MB/s + ETA in the output"
