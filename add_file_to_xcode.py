#!/usr/bin/env python3
import re
import uuid

def add_file_to_xcode_project():
    # Read the project file
    with open('Saucey.xcodeproj/project.pbxproj', 'r') as f:
        content = f.read()

    # Generate unique UUIDs for the file references
    file_ref_uuid = str(uuid.uuid4()).replace('-', '').upper()[:24]
    build_file_uuid = str(uuid.uuid4()).replace('-', '').upper()[:24]

    # Find the PBXFileReference section and add our file
    file_ref_pattern = r'(\/\* Begin PBXFileReference section \*\/.*?)(\/\* End PBXFileReference section \*\/)'
    file_ref_match = re.search(file_ref_pattern, content, re.DOTALL)

    if file_ref_match:
        file_ref_section = file_ref_match.group(1)
        new_file_ref = f'\t\t{file_ref_uuid} /* CookingPreferencesView.swift */ = {{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = CookingPreferencesView.swift; sourceTree = "<group>"; }};\n'
        updated_file_ref_section = file_ref_section + new_file_ref
        content = content.replace(file_ref_match.group(1), updated_file_ref_section)
        print("✅ Added file reference")

    # Find the PBXBuildFile section and add our file
    build_file_pattern = r'(\/\* Begin PBXBuildFile section \*\/.*?)(\/\* End PBXBuildFile section \*\/)'
    build_file_match = re.search(build_file_pattern, content, re.DOTALL)

    if build_file_match:
        build_file_section = build_file_match.group(1)
        new_build_file = f'\t\t{build_file_uuid} /* CookingPreferencesView.swift in Sources */ = {{isa = PBXBuildFile; fileRef = {file_ref_uuid} /* CookingPreferencesView.swift */; }};\n'
        updated_build_file_section = build_file_section + new_build_file
        content = content.replace(build_file_match.group(1), updated_build_file_section)
        print("✅ Added build file reference")

    # Find a Views group to add our file to (look for RecipeGenerationSettingsView as reference)
    views_pattern = r'(.*RecipeGenerationSettingsView\.swift.*?children = \([^)]*)((\s+\w+ \/\* \w+\.swift \*\/,\s*)*)'
    views_match = re.search(views_pattern, content, re.DOTALL)
    
    if views_match:
        # Find the end of the children array and add our file
        children_end_pattern = r'(\w+ \/\* RecipeGenerationSettingsView\.swift \*\/,)'
        content = re.sub(children_end_pattern, 
                        rf'\1\n\t\t\t\t{file_ref_uuid} /* CookingPreferencesView.swift */,', 
                        content)
        print("✅ Added file to Views group")

    # Find the Sources build phase and add our file
    sources_pattern = r'(\w+ \/\* RecipeGenerationSettingsView\.swift in Sources \*\/,)'
    content = re.sub(sources_pattern, 
                    rf'\1\n\t\t\t\t{build_file_uuid} /* CookingPreferencesView.swift in Sources */,', 
                    content)
    print("✅ Added file to Sources build phase")

    # Write back the updated content
    with open('Saucey.xcodeproj/project.pbxproj', 'w') as f:
        f.write(content)

    print(f'\n🎉 Successfully added CookingPreferencesView.swift to Xcode project!')
    print(f'File Reference UUID: {file_ref_uuid}')
    print(f'Build File UUID: {build_file_uuid}')

if __name__ == "__main__":
    add_file_to_xcode_project() 