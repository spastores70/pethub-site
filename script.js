let cart = [];

const buttons = document.querySelectorAll(".product-card button");

buttons.forEach((button) => {
  button.addEventListener("click", () => {
    const product = button.parentElement;
    const name = product.querySelector("h3").innerText;
    const price = product.querySelector(".price").innerText;

    cart.push({ name, price });

    updateCartCount();
    alert(name + " added to cart!");
  });
});

function updateCartCount() {
  const cartCount = document.getElementById("cart-count");

  if (cartCount) {
    cartCount.innerText = cart.length;
  }
}