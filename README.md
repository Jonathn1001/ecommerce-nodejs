# ecommerce-nodejs

sudo chown -R mongodb:mongodb /var/lib/mongodb
sudo chown mongodb:mongodb /tmp/mongodb-27017.sock  
sudo service mongod restart

# Khoa phan tan duoc su dung de dam bao tai nguyen duoc truy cap boi duy nhat mot nguoi trong mot thoi diem.

docker run --name mdb -v /var/lib/mongodb/:/data/db -p 27017:27017 -d mongo
git config core.fileMode false