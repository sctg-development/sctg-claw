#!/bin/bash

# Create llm.md file integrating README.md and source code (excluding openclaw and .gitignore files)

# Initialize the llm.md file with README.md content
cat README.md > llm.md

# Add a separator for the source code section
echo -e "\n\n---\n\n# Source Code\n\n" >> llm.md

# Find all files excluding .git directory, openclaw directory, and .gitignore patterns
# We'll process each file and add its content to llm.md

# Get list of files to include (using array instead of mapfile for macOS compatibility)
while IFS= read -r -d $'\0' file; do
  files+=("$file")
done < <(find . -type f \
  -not -path "*/.git/*" \
  -not -path "*/openclaw/*" \
  -not -name ".gitignore" \
  -not -name "llm.md" \
  -not -name "create_llm_md.sh" \
  -not -name "README.md" \
  -not -name ".values.yaml" \
  -not -name "*.gz" \
  -not -name "*.zip" \
  -not -name "*.tar" \
  -not -name "*.tar.gz" \
  -not -name "*.tar.bz2" \
  -not -name "*.tar.xz" \
  -not -name "*.tgz" \
  -print0 | sort -z)

# Process each file
for file in "${files[@]}"; do
  # Skip directories and special files
  if [[ -f "$file" && ! -L "$file" ]]; then
    # Add file header
    echo -e "\n## File: $file\n\n\`\`\`\n" >> llm.md
    
    # Add file content
    cat "$file" >> llm.md
    
    # Close code block
    echo -e "\n\`\`\`\n" >> llm.md
  fi
done

echo "llm.md created successfully with README.md and all source code (excluding openclaw and .gitignore files)"
