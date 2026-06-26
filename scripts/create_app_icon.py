import os
import subprocess
import shutil
from PIL import Image

def create_app_icon():
    source_path = "branding/logo-highres.png"
    if not os.path.exists(source_path):
        print(f"Error: Source logo {source_path} not found.")
        return
        
    img = Image.open(source_path).convert("RGBA")
    
    # Let's make the background transparent
    # Standard source logo has a white background (R>245, G>245, B>245)
    data = img.getdata()
    new_data = []
    for pixel in data:
        r, g, b, a = pixel
        # If it's a white or very light pixel, make it transparent
        if r > 240 and g > 240 and b > 240:
            new_data.append((255, 255, 255, 0))
        else:
            new_data.append(pixel)
    img.putdata(new_data)
    
    # We want to crop to the content bounding box to center it nicely
    bbox = img.getbbox()
    if bbox:
        content = img.crop(bbox)
        content_w = bbox[2] - bbox[0]
        content_h = bbox[3] - bbox[1]
        
        # Center in a square canvas of max(content_w, content_h)
        size = max(content_w, content_h) + 60 # add padding
        square_img = Image.new("RGBA", (size, size), (255, 255, 255, 0))
        paste_x = (size - content_w) // 2
        paste_y = (size - content_h) // 2
        square_img.paste(content, (paste_x, paste_y), content)
        img = square_img
        
    print(f"Processed logo transparency and centering. Final square size: {img.width}x{img.height}")
    
    # Create iconset directory
    iconset_dir = "icon.iconset"
    os.makedirs(iconset_dir, exist_ok=True)
    
    # Icon sizes required for macOS .icns
    sizes = [
        ("16x16", 16),
        ("16x16@2x", 32),
        ("32x32", 32),
        ("32x32@2x", 64),
        ("128x128", 128),
        ("128x128@2x", 256),
        ("256x256", 256),
        ("256x256@2x", 512),
        ("512x512", 512),
        ("512x512@2x", 1024)
    ]
    
    for suffix, size in sizes:
        resized = img.resize((size, size), Image.Resampling.LANCZOS)
        resized.save(f"{iconset_dir}/icon_{suffix}.png", "PNG")
        
    # Generate the .icns file
    output_icns = "ui/renderer/icon.icns"
    os.makedirs(os.path.dirname(output_icns), exist_ok=True)
    
    try:
        subprocess.run(["iconutil", "-c", "icns", iconset_dir, "-o", output_icns], check=True)
        print(f"Successfully generated macOS application icon: {output_icns}")
        # Also copy it to a standard PNG fallback in the same directory just in case
        img.resize((512, 512), Image.Resampling.LANCZOS).save("ui/renderer/icon.png", "PNG")
        print("Generated fallback ui/renderer/icon.png")
    except Exception as e:
        print(f"Error compiling .icns via iconutil: {e}")
        
    # Clean up iconset folder
    shutil.rmtree(iconset_dir)

if __name__ == "__main__":
    create_app_icon()
