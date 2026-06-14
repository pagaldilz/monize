-- Insert Social Security for users who don't have it
INSERT INTO categories (user_id, parent_id, name, is_income)
SELECT u.id, p.id, 'Social Security', false
FROM users u
JOIN categories p ON p.user_id = u.id AND p.name = 'Taxes' AND p.parent_id IS NULL
WHERE NOT EXISTS (
    SELECT 1 FROM categories c 
    WHERE c.user_id = u.id AND c.name = 'Social Security' AND c.parent_id = p.id
);

-- Insert Medicare for users who don't have it
INSERT INTO categories (user_id, parent_id, name, is_income)
SELECT u.id, p.id, 'Medicare', false
FROM users u
JOIN categories p ON p.user_id = u.id AND p.name = 'Taxes' AND p.parent_id IS NULL
WHERE NOT EXISTS (
    SELECT 1 FROM categories c 
    WHERE c.user_id = u.id AND c.name = 'Medicare' AND c.parent_id = p.id
);

-- Insert State Income for users who don't have it
INSERT INTO categories (user_id, parent_id, name, is_income)
SELECT u.id, p.id, 'State Income', false
FROM users u
JOIN categories p ON p.user_id = u.id AND p.name = 'Taxes' AND p.parent_id IS NULL
WHERE NOT EXISTS (
    SELECT 1 FROM categories c 
    WHERE c.user_id = u.id AND c.name = 'State Income' AND c.parent_id = p.id
);
