import os
from PIL import Image

def extract_icons():
    img = Image.open("icons.png").convert("RGBA")
    
    # Precise boundaries detected from analysis
    # format: (name, (x_min, y_min, x_max, y_max))
    icon_specs = [
        ("quiver-logo", (138, 144, 317, 323)),
        ("goals", (437, 144, 598, 323)),
        ("search", (726, 144, 893, 323)),
        
        ("cli", (135, 461, 324, 624)),
        ("database", (422, 461, 610, 624)),
        ("browser", (717, 461, 891, 624)),
        
        ("deep-search", (135, 756, 324, 929)),
        ("github", (433, 756, 586, 929)),
        ("edit", (720, 756, 891, 929)),
        
        ("folder", (144, 1051, 317, 1202)),
        ("settings", (429, 1051, 612, 1202)),
        ("verification", (728, 1051, 874, 1202))
    ]
    
    os.makedirs("ui/renderer/assets", exist_ok=True)
    os.makedirs("branding", exist_ok=True)
    
    for name, bounds in icon_specs:
        x_min, y_min, x_max, y_max = bounds
        
        # Add safety padding to bounds
        padding = 10
        x_min_p = max(0, x_min - padding)
        y_min_p = max(0, y_min - padding)
        x_max_p = min(img.width, x_max + padding)
        y_max_p = min(img.height, y_max + padding)
        
        # Crop
        content = img.crop((x_min_p, y_min_p, x_max_p, y_max_p))
        content_w = x_max_p - x_min_p
        content_h = y_max_p - y_min_p
        
        # Create a new square transparent canvas (256x256)
        size = 256
        icon = Image.new("RGBA", (size, size), (255, 255, 255, 0))
        
        # Scale content to fit 180x180 max inside 256x256
        max_size = 190
        scale = min(max_size / content_w, max_size / content_h)
        if scale < 1.0:
            new_w = int(content_w * scale)
            new_h = int(content_h * scale)
            content_scaled = content.resize((new_w, new_h), Image.Resampling.LANCZOS)
        else:
            new_w = content_w
            new_h = content_h
            content_scaled = content
            
        # Center content on transparent canvas
        paste_x = (size - new_w) // 2
        paste_y = (size - new_h) // 2
        icon.paste(content_scaled, (paste_x, paste_y), content_scaled)
        
        # Save icon
        output_path = f"ui/renderer/assets/icon-{name}.png"
        icon.save(output_path, "PNG")
        print(f"Saved: {output_path} (content size: {content_w}x{content_h} scaled to {new_w}x{new_h})")
        
        # Special copy for main Quiver logo
        if name == "quiver-logo":
            icon.save("ui/renderer/assets/logo.png", "PNG")
            icon.save("branding/logo.png", "PNG")
            print("Saved main logo copies as logo.png")

if __name__ == "__main__":
    extract_icons()
